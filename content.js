const isEOC = location.host.includes('coupang.net');
const isZD = location.host.includes('zendesk.com') || location.host.includes('google.com');

// ============================================================================
// [EOC] 데이터 수집 (엑셀 명세 기반 정밀 파싱)
// ============================================================================
if (isEOC) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-testid="zendesk_order_ticket_async"]');
    if (btn) {
      const tags = parseEOCPage(document);
      chrome.storage.local.set({ "transfer_buffer": { ...tags, _ts: Date.now() } });
    }
  });
}

function findCardByHeader(doc, headerText) {
  const cards = doc.querySelectorAll('.order-detail-card');
  for (const card of cards) {
    const header = card.querySelector('.el-card__header .clearfix span');
    if (header && header.textContent.trim() === headerText) return card;
  }
  return null;
}

function findValueInTable(card, labelText) {
  if (!card) return null;
  const rows = card.querySelectorAll('.order-detail-table tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2 && cells[0].textContent.trim() === labelText) return cells[1].textContent.trim();
  }
  return null;
}

function extractNumber(text) {
  if (!text) return 0;
  return parseInt(text.replace(/[^\d]/g, '')) || 0;
}

function getRelativeDate(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return '';
  const diffDays = Math.floor((new Date() - new Date(`${match[1]}-${match[2]}-${match[3]}`)) / (1000 * 60 * 60 * 24));
  return `${diffDays === 0 ? '오늘' : diffDays + '일 전'}, ${match[4]}시 ${match[5]}분`;
}

function parseEOCPage(doc) {
  const eoc원문 = {}; 
  const tags = {};

  // 1. 주문정보
  const orderInfoCard = findCardByHeader(doc, '주문정보');
  if (orderInfoCard) {
    const orderType = findValueInTable(orderInfoCard, '주문 유형');
    eoc원문.배달유형 = (orderType && orderType.includes('세이브')) ? '무료배달' : '한집배달';
    
    eoc원문.축약형주문번호 = (findValueInTable(orderInfoCard, '축약형 주문 ID') || '').split('\n')[0].trim();
    eoc원문.고유주문번호 = (findValueInTable(orderInfoCard, '고유 주문 ID') || '').split('\n')[0].trim();
    eoc원문.스토어id = (findValueInTable(orderInfoCard, '스토어 ID') || '').split('\n')[0].trim();
    eoc원문.회원번호 = (findValueInTable(orderInfoCard, '회원 번호') || '').split('\n')[0].trim();
    eoc원문.상태 = findValueInTable(orderInfoCard, '상태');
    eoc원문.예상조리소요시간 = findValueInTable(orderInfoCard, 'Merchant Input (Excludes merchant delay)');
    eoc원문.조리지연 = findValueInTable(orderInfoCard, 'Merchant Delay');

    const eta1 = findValueInTable(orderInfoCard, 'ETA 1');
    if (eta1) {
      const m = eta1.match(/최초시간\s+(\d{2}):(\d{2})/);
      if (m) { eoc원문.eta1_int = parseInt(m[1])*60 + parseInt(m[2]); eoc원문.eta1_str = `${m[1]}시 ${m[2]}분`; }
    }
    const eta3 = findValueInTable(orderInfoCard, 'ETA 3');
    if (eta3) {
      const times = [...eta3.matchAll(/(\d{2}):(\d{2})/g)].slice(1).map(m => `${m[1]}:${m[2]}`);
      eoc원문.픽업후갱신 = times.join(', ');
    }
    const payment = findValueInTable(orderInfoCard, '결제 금액');
    if (payment) {
      const pMatch = payment.match(/₩([\d,]+)/); if (pMatch) eoc원문.결제금액 = parseInt(pMatch[1].replace(/,/g, ''));
      const sMatch = payment.match(/판매가격:\s*₩([\d,]+)/); if (sMatch) eoc원문.판매가격 = parseInt(sMatch[1].replace(/,/g, ''));
    }
    const createTime = findValueInTable(orderInfoCard, '생성시간');
    if (createTime) eoc원문.결제시각 = getRelativeDate(createTime);
    eoc원문.스토어요청사항 = findValueInTable(orderInfoCard, '비고') || '';
  }

  // 2. 주문 메뉴
  const menuCard = findCardByHeader(doc, '주문 메뉴');
  if (menuCard) {
    const menuTable = menuCard.querySelector('.el-table__body');
    if (menuTable) {
      const menuList = [];
      const menuItemsLegacy = [];
      menuTable.querySelectorAll('.el-table__row').forEach(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length >= 3) {
          const menuText = cells[2].textContent.trim();
          const lines = menuText.split('\n').filter(l => l.trim());
          let formatted = '';
          lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('옵션:')) formatted += '  ' + line + '\n'; else formatted += line + '\n';
          });
          menuList.push(formatted.trim());
          menuItemsLegacy.push({ menuId: cells[0].textContent.trim(), price: cells[1].textContent.trim(), details: cells[2].textContent.trim() });
        }
      });
      eoc원문.주문메뉴 = menuList.join('\n\n');
      tags["_주문메뉴_목록"] = menuItemsLegacy;
    }
  }

  // 3. 결제 (쿠폰)
  const paymentCard = findCardByHeader(doc, '결제');
  if (paymentCard) {
    let disc = 0, delivDisc = 0;
    const h4s = paymentCard.querySelectorAll('h4');
    let couponHeader = null;
    h4s.forEach(h => { if(h.textContent.includes('쿠폰')) couponHeader = h; });
    if (couponHeader) {
      let nextEl = couponHeader.nextElementSibling;
      while (nextEl && !nextEl.classList.contains('el-table')) nextEl = nextEl.nextElementSibling;
      if (nextEl) {
        nextEl.querySelectorAll('.el-table__row').forEach(row => {
          const cells = row.querySelectorAll('.el-table__cell');
          if (cells.length >= 3) {
            const type = cells[1].textContent.trim();
            const price = extractNumber(cells[2].textContent);
            if (type.includes('상품 할인') || type.includes('디쉬 할인')) disc += price;
            else if (type.includes('배달비')) delivDisc += price;
          }
        });
      }
    }
    eoc원문.할인금액 = disc; eoc원문.배달비 = delivDisc; tags["상품할인"] = disc;
  }

  // 4. 배달지
  const deliveryCard = findCardByHeader(doc, '배달지');
  if (deliveryCard) {
    eoc원문.고객전화 = (findValueInTable(deliveryCard, '전화번호') || '').split('\n')[0].trim();
    const road = findValueInTable(deliveryCard, '도로명 주소');
    const place = findValueInTable(deliveryCard, '지명');
    const detail = findValueInTable(deliveryCard, '상세 주소');
    eoc원문.배달지 = [road, (place && place !== road ? place : null), detail].filter(v => v).join(', ');
    tags["통합주소"] = eoc원문.배달지;
    const req = findValueInTable(deliveryCard, '선택된 배송요청사항');
    const memo = findValueInTable(deliveryCard, '비고');
    const tip = findValueInTable(deliveryCard, '배달팁');
    eoc원문.배달요청사항_비고_배달팁 = [req, memo, tip].filter(v => v && v.trim()).join(' / ');
  }

  // 5. 스토어
  const storeCard = findCardByHeader(doc, '스토어');
  if (storeCard) {
    eoc원문.머천트id = (findValueInTable(storeCard, '머천트 ID') || '').split('\n')[0].trim();
    eoc원문.스토어명 = (findValueInTable(storeCard, '이름') || '').split('\n')[0].trim();
    eoc원문.스토어번호 = (findValueInTable(storeCard, '전화번호') || '').split('\n')[0].trim();
    eoc원문.영업상태 = findValueInTable(storeCard, '영업 상태');
    const pos = findValueInTable(storeCard, 'POS 타입');
    if (pos) eoc원문.포스타입 = pos.toUpperCase().includes('COUPANG_POS') ? '쿠팡포스' : '쿠팡포스외';
  }

  // 6. 쿠리어
  const courierCard = findCardByHeader(doc, '쿠리어');
  if (courierCard) {
    eoc원문.배달파트너id = (findValueInTable(courierCard, '쿠리어 ID') || '').split('\n')[0].trim();
    eoc원문.배달파트너전화 = (findValueInTable(courierCard, '전화번호') || '').split('\n')[0].trim();
    eoc원문.배달유형_쿠리어 = findValueInTable(courierCard, '배달 유형');
    let cType = null;
    const typeRow = Array.from(courierCard.querySelectorAll('.order-detail-table tr')).find(r => r.textContent.includes('쿠리어 타입'));
    if (typeRow) {
        const checkedRadio = typeRow.querySelector('input[type="radio"]:checked');
        if (checkedRadio) cType = checkedRadio.parentElement.textContent.trim();
        else {
            const valCell = typeRow.querySelectorAll('td')[1];
            if(valCell) cType = valCell.textContent.trim();
        }
    }
    eoc원문.배달파트너타입 = cType || '';
  }

  // 7. 이슈내용
  const issueCard = findCardByHeader(doc, '이슈 내용');
  if (issueCard) {
    const inquiryTime = findValueInTable(issueCard, '문의한 시간');
    if (inquiryTime) eoc원문.문의시각 = getRelativeDate(inquiryTime);
    eoc원문.문의유형 = findValueInTable(issueCard, '문의 유형');
    eoc원문.요청해결책 = findValueInTable(issueCard, '원하는 해결책');
    eoc원문.작성내용 = findValueInTable(issueCard, '작성내용');
  }

  // 8. 이력
  const historyCard = findCardByHeader(doc, '이력');
  if (historyCard) {
    const historyTable = historyCard.querySelector('.el-table__body');
    if (historyTable) {
      const historyRows = historyTable.querySelectorAll('.el-table__row');
      const historyItems = [];
      historyRows.forEach(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length >= 6) {
          const status = cells[2].textContent.trim();
          const createdText = cells[5].textContent.trim();
          const timeMatch = createdText.match(/(\d{2}):(\d{2}):(\d{2})/);
          if (timeMatch && status) {
            const h = parseInt(timeMatch[1]);
            const m = parseInt(timeMatch[2]);
            const timeStr = `${h}시 ${m}분`;
            if (status === '배달 완료') {
                const fullMatch = createdText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
                if(fullMatch) {
                    tags["배달완료시각"] = `${fullMatch[4]}시 ${fullMatch[5]}분`;
                    tags["_배달완료_시"] = fullMatch[4];
                    tags["_배달완료_분"] = fullMatch[5];
                }
            }
            if (status.includes('픽업') || status.includes('Pick Up') || status.includes('배달 시작')) tags["픽업시각"] = timeStr;
            historyItems.push({ 상태: status, 시각_int: h * 60 + m, 시각_str: timeStr });
          }
        }
      });
      eoc원문.이력 = historyItems;
    }
  }

  // 안전장치
  doc.querySelectorAll('.order-detail-card').forEach(card => {
    card.querySelectorAll('.order-detail-table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if(cells.length >= 2) {
            const k = cells[0].textContent.trim();
            const v = cells[1].textContent.trim();
            if(k && v && !tags[k]) tags[k] = v.split('\n')[0];
        }
    });
  });

  Object.assign(tags, eoc원문);

  if (eoc원문.eta1_str) {
    tags["ETA1_시각"] = eoc원문.eta1_str;
    const [h, m] = eoc원문.eta1_str.replace('분','').split('시 ');
    tags["_ETA1_시"] = parseInt(h); tags["_ETA1_분"] = parseInt(m);
  }

  const salesPrice = tags["판매금액"] || 0;
  const productDiscount = tags["상품할인"] || 0;
  if (salesPrice > 0) {
    const ratio = ((salesPrice - productDiscount) / salesPrice * 100).toFixed(2);
    tags["_안분가"] = `${ratio}%`;
    tags["_판매금액_숫자"] = salesPrice;
    tags["_상품할인_숫자"] = productDiscount;
  }
  
  tags.eoc원문 = eoc원문;
  return tags;
}

// ============================================================================
// [Zendesk] UI
// ============================================================================
if (isZD) {
  let ticketStore = {}, utteranceData = {}, userSettings = { name: "", quickButtons: [], smsTemplates: [] }, lastPath = location.pathname;

  fetch(chrome.runtime.getURL('data_generated.json')).then(r => r.json()).then(data => { 
    utteranceData = data.scenarios; initUI(); 
  });

  function initUI() {
    const panel = document.createElement('div');
    panel.id = 'zd-helper-panel';
    // [CSS] 심플 스타일
    Object.assign(panel.style, {
        position: 'fixed', top: '10px', right: '10px', width: '300px',
        backgroundColor: '#fff', border: '1px solid #000', color: '#000',
        zIndex: '2147483647', padding: '5px', maxHeight:'90vh', overflowY:'auto',
        fontSize: '12px', fontFamily: 'sans-serif'
    });

    panel.innerHTML = `
      <div id="header" style="border-bottom:1px solid #ccc; margin-bottom:5px; padding-bottom:5px; font-weight:bold; cursor:pointer; display:flex; justify-content:space-between;" title="클릭하여 접기/펼치기">
        <span><span id="timer-display" style="color:blue;">00:00</span> <span id="info-header" style="font-size:11px;">대기중...</span></span>
        <button id="home-btn" style="cursor:pointer;">🏠</button>
      </div>
      
      <div id="panel-body" style="display:none;">
          <div style="margin-bottom:8px; display:flex; gap:2px;">
            <button onclick="window.switchTab('view-eoc')" style="flex:1;">EOC</button>
            <button onclick="window.switchTab('view-script')" style="flex:1;">스크립트</button>
            <button onclick="window.switchTab('view-sms')" style="flex:1;">SMS</button>
            <button onclick="window.switchTab('view-calc')" style="flex:1;">계산</button>
            <button onclick="window.switchTab('view-settings')" style="flex:1;">설정</button>
          </div>

          <div id="view-eoc" class="tab-view">
            <div id="eoc-detail-view"></div>
            <div id="anbunga-container" style="background:#eee; padding:2px; margin-top:5px; font-size:11px; border:1px solid #eee;"></div>
          </div>

          <div id="view-script" class="tab-view" style="display:none;">
            <div id="btn-container"></div>
            <hr style="margin:8px 0;">
            <div style="font-size:10px; font-weight:bold; margin-bottom:4px;">⚡ 퀵 버튼</div>
            <div id="quick-btn-container"></div>
          </div>

          <div id="view-sms" class="tab-view" style="display:none;">
            <div style="font-size:10px; font-weight:bold; margin-bottom:4px;">💬 SMS 템플릿</div>
            <div id="sms-container"></div>
          </div>

          <div id="view-calc" class="tab-view" style="display:none;">
            <h4 style="margin:0 0 5px 0;">🧮 안분가 계산기</h4>
            <div id="calc-ratio-box" style="font-size:11px; color:blue; margin-bottom:5px; background:#e3f2fd; padding:5px;">데이터 대기 중...</div>
            <input id="calc-input" type="number" placeholder="금액 입력" style="width:100%; padding:5px; margin-bottom:5px; box-sizing:border-box;">
            <button id="calc-btn" style="width:100%; padding:5px;">계산 및 복사</button>
            <div id="calc-result" style="margin-top:5px; font-weight:bold; color:green;"></div>
          </div>

          <div id="view-settings" class="tab-view" style="display:none;">
            <div>상담사 이름</div>
            <input id="set-name" type="text" style="width:100%; margin-bottom:5px;">
            <div>퀵버튼 JSON (그룹형)</div>
            <textarea id="quick-buttons" style="width:100%; height:60px; margin-bottom:5px;"></textarea>
            <div>SMS JSON (그룹형)</div>
            <textarea id="sms-templates" style="width:100%; height:60px; margin-bottom:5px;"></textarea>
            <button id="save-settings" style="width:100%; padding:5px;">저장</button>
          </div>
      </div>
    `;
    document.body.appendChild(panel);

    // 드래그 & 토글 로직
    const header = document.getElementById('header');
    const body = document.getElementById('panel-body');
    let isDragging=false, startX, startY, initialLeft, initialTop;
    let isClick = true;

    header.addEventListener('mousedown', (e) => {
        if(e.target.tagName==='BUTTON') return;
        isDragging = true; isClick = true; 
        startX = e.clientX; startY = e.clientY;
        const rect = panel.getBoundingClientRect(); initialLeft = rect.left; initialTop = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) isClick = false;
        panel.style.left = (initialLeft + e.clientX - startX) + 'px';
        panel.style.top = (initialTop + e.clientY - startY) + 'px';
        panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', (e) => {
        if (isDragging && isClick && !e.target.closest('button')) {
            // 클릭 시 토글
            body.style.display = body.style.display === 'none' ? 'block' : 'none';
        }
        isDragging = false;
    });

    // 탭 전환
    window.switchTab = (id) => {
        document.querySelectorAll('.tab-view').forEach(el => el.style.display = 'none');
        document.getElementById(id).style.display = 'block';
    };

    document.getElementById('home-btn').onclick = () => { 
        if(ticketStore[getTid()]) { ticketStore[getTid()].scenario = null; ticketStore[getTid()].tree = []; refreshUI(); }
        window.switchTab('view-script');
    };

    // 파스텔 색상 매핑
    function getPastel(color) {
        const map = {
            blue: { bg:'#e3f2fd', txt:'#1565c0', bd:'#90caf9' },
            red: { bg:'#ffebee', txt:'#c62828', bd:'#ef9a9a' },
            green: { bg:'#e8f5e9', txt:'#2e7d32', bd:'#a5d6a7' },
            yellow: { bg:'#fffde7', txt:'#f9a825', bd:'#fff59d' },
            purple: { bg:'#f3e5f5', txt:'#6a1b9a', bd:'#ce93d8' },
            gray: { bg:'#f5f5f5', txt:'#616161', bd:'#bdbdbd' }
        };
        return map[color] || map.gray;
    }

    // 그룹 버튼 렌더러
    function renderGroups(containerId, data) {
        const c = document.getElementById(containerId);
        c.innerHTML = '';
        if(!data || !Array.isArray(data)) { c.innerHTML = '<div style="color:#999;font-size:9px;">설정 없음</div>'; return; }
        
        data.forEach(g => {
            const style = getPastel(g.color);
            const div = document.createElement('div');
            div.style.marginBottom = '6px';
            div.innerHTML = `<div style="font-size:10px; color:#666; margin-bottom:2px; font-weight:bold;">${g.group || '그룹'}</div>`;
            const btnWrap = document.createElement('div');
            btnWrap.style.display = 'flex';
            btnWrap.style.flexWrap = 'wrap';
            btnWrap.style.gap = '3px';
            
            (g.buttons||[]).forEach(btn => {
                const b = document.createElement('button');
                b.className = 'action-btn'; 
                b.innerText = btn.label;
                b.title = btn.text;
                Object.assign(b.style, {
                    backgroundColor: style.bg, color: style.text, border: '1px solid '+style.bd,
                    fontSize: '11px', padding: '4px 8px', borderRadius: '3px', fontWeight: 'bold'
                });
                b.onclick = () => navigator.clipboard.writeText(tagEngine(btn.text, ticketStore[getTid()]?.eoc || {}, userSettings));
                btnWrap.appendChild(b);
            });
            div.appendChild(btnWrap);
            c.appendChild(div);
        });
    }

    // 계산기
    document.getElementById('calc-btn').onclick = () => {
        const eoc = ticketStore[getTid()]?.eoc?.eoc원문;
        if (!eoc || !eoc.판매가격) return alert('판매금액 데이터가 없습니다.');
        const sales = eoc.판매가격;
        const discount = eoc.할인금액 || 0;
        const inputVal = parseFloat(document.getElementById('calc-input').value);
        if(!inputVal) return alert('금액 입력');
        const res = Math.round(((sales - discount) / sales) * inputVal);
        document.getElementById('calc-result').innerText = `${res.toLocaleString()}원`;
        navigator.clipboard.writeText(res.toString());
    };

    document.getElementById('save-settings').onclick = () => {
      userSettings.name = document.getElementById('set-name').value;
      try { 
          userSettings.quickButtons = JSON.parse(document.getElementById('quick-buttons').value || "[]"); 
          userSettings.smsTemplates = JSON.parse(document.getElementById('sms-templates').value || "[]");
      } catch(e) { return alert("JSON 오류: " + e.message); }
      chrome.storage.local.set({userSettings}); alert("저장됨"); renderGroups('quick-btn-container', userSettings.quickButtons); renderGroups('sms-container', userSettings.smsTemplates); refreshUI();
    };

    // [핵심] UI 갱신 (EOC 원문 디자인 100% 복구)
    window.refreshUI = () => {
      const tid = getTid(); if (!tid) return;
      if (!ticketStore[tid]) ticketStore[tid] = { scenario: null, tree: [], eoc: {} };
      const data = ticketStore[tid], eoc = data.eoc || {};

      if (eoc["고유주문번호"]) {
        document.getElementById('info-header').innerText = `*${eoc["고유주문번호"].slice(-4)} | ${eoc["축약형주문번호"] || ""} | ${eoc["스토어명"] || ""}`;
      }

      // EOC 뷰
      const eocView = document.getElementById('eoc-detail-view');
      if (!data.eoc || Object.keys(data.eoc).length === 0) {
        eocView.innerHTML = '<div style="padding:4px; font-size:9px;">EOC 데이터 없음</div>';
      } else {
        const o = eoc.eoc원문 || {};
        const storePhone = (o.스토어번호 || "").replace(/-/g, "");
        const courierPhone = (o.배달파트너전화 || "").replace(/-/g, "");
        const pickupTime = eoc["픽업시각"] || "";
        const completeTime = eoc["배달완료시각"] || "";
        
        let delayInfo = "-";
        let delayColor = "#666";
        if (eoc["_ETA1_시"] && eoc["_ETA1_분"]) {
            const eta = eoc["_ETA1_시"] * 60 + eoc["_ETA1_분"];
            let cur = 0;
            if (eoc["_배달완료_시"]) {
                cur = parseInt(eoc["_배달완료_시"]) * 60 + parseInt(eoc["_배달완료_분"]);
                const diff = cur - eta;
                delayInfo = `${diff > 0 ? "+" : ""}${diff}분 (완료)`;
                delayColor = diff > 0 ? "red" : "blue";
            } else {
                const now = new Date(); cur = now.getHours() * 60 + now.getMinutes();
                const diff = cur - eta;
                delayInfo = `${diff > 0 ? "+" : ""}${diff}분 (진행중)`;
                delayColor = diff > 0 ? "red" : "green";
            }
        }

        let menuHtml = '';
        if (o.주문메뉴) {
            menuHtml = o.주문메뉴.split('\n').filter(l=>l.trim()).map(line => 
                `<div class="copyable-row" style="cursor:pointer; padding:1px 0;" onclick="navigator.clipboard.writeText('${line.replace(/'/g, "\\'")}')" title="복사">
                   ${line}
                 </div>`
            ).join('');
        }

        // 사용자가 제공한 원본 디자인 코드
        eocView.innerHTML = `
          <div style="padding: 0; font-size: 10px; border: 1px solid #ccc; background: #fff;">
            <button id="toggle-raw-eoc" style="width:100%; border:none; border-bottom:1px solid #ccc; background:#f0f0f0; padding:4px; cursor:pointer; text-align:left; font-weight:bold;">
              [EOC 원문 보기 ▼]
            </button>
            <div id="raw-eoc-data" style="display:none; max-height:200px; overflow-y:auto; background:#f9f9f9; border-bottom:1px solid #ccc; padding:4px;">
                <pre style="white-space:pre-wrap; font-size:8px;">${JSON.stringify(o, null, 2)}</pre>
            </div>

            <div style="padding: 6px; border-bottom: 1px solid #ccc;">
               ${makeRow("주문유형", o.배달유형)}
               ${makeRow("고유번호", o.고유주문번호)}
               ${makeRow("매장명", o.스토어명)}
               ${makeRow("전화번호", storePhone)}
               ${makeRow("결제시각", o.결제시각)}
               ${makeRow("축약번호", o.축약형주문번호)}
            </div>

            <div style="padding: 6px; border-bottom: 1px solid #ccc;">
               <div style="font-weight:bold; margin-bottom:4px;">주문 메뉴</div>
               <div style="color:#444; line-height:1.3;">${menuHtml || '정보 없음'}</div>
            </div>

            <div style="padding: 6px; border-bottom: 1px solid #ccc;">
               ${makeRow("판매가격", o.판매가격 ? `₩${o.판매가격.toLocaleString()}` : "")}
               ${makeRow("상품할인", o.할인금액 ? `₩${o.할인금액.toLocaleString()}` : "₩0")}
            </div>

            <div style="padding: 6px;">
               ${makeRow("파트너유형", o.배달파트너타입)}
               ${makeRow("파트너ID", o.배달파트너id)}
               ${makeRow("파트너전화", courierPhone)}
               <div style="margin-top:4px; padding-top:4px; border-top:1px dashed #eee;">
                 ${makeRow("픽업시각", pickupTime)}
                 ${makeRow("완료시각", completeTime)}
                 <div style="display:flex; justify-content:flex-start; margin-bottom:2px;">
                    <span style="color:#666; font-weight:bold; min-width:60px;">지연경과</span>
                    <span style="color:${delayColor}; font-weight:bold;">| ${delayInfo}</span>
                 </div>
               </div>
            </div>
          </div>`;
          
          document.getElementById('toggle-raw-eoc').onclick = function() {
            const el = document.getElementById('raw-eoc-data');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
          };
      }

      // 계산기 비율
      const cBox = document.getElementById('calc-ratio-box');
      if(eoc.eoc원문?.판매가격) {
          const r = ((eoc.eoc원문.판매가격 - (eoc.eoc원문.할인금액||0))/eoc.eoc원문.판매가격*100).toFixed(2);
          cBox.innerHTML = `적용 비율: ${r}%`;
      } else { cBox.innerHTML = `데이터 없음`; }

      // 3. 퀵버튼 & SMS
      renderGroups('quick-btn-container', userSettings.quickButtons);
      renderGroups('sms-container', userSettings.smsTemplates);

      // 4. 스크립트
      const btnBox = document.getElementById('btn-container'); btnBox.innerHTML = '';
      if (!data.scenario) {
        Object.keys(utteranceData).forEach(cat => {
          const b = document.createElement('button'); b.innerText = cat;
          b.className = 'action-btn btn-choice'; // 기존 CSS 클래스 사용
          b.onclick = () => { data.scenario = cat; data.tree = []; refreshUI(); };
          btnBox.appendChild(b);
        });
      } else {
        const renderTree = (tree) => {
            tree.forEach((n, idx) => {
                const b = document.createElement('button'); b.innerText = n.label;
                b.className = `action-btn btn-${n.type}`;
                b.onclick = () => { tree.splice(idx + 1); refreshUI(); };
                btnBox.appendChild(b);
                btnBox.appendChild(document.createElement('div')).className='branch-marker';
            });
        };
        renderTree(data.tree);
        const current = data.tree.length === 0 ? 'start' : data.tree[data.tree.length - 1].next;
        const options = utteranceData[data.scenario][current] || [];
        options.forEach(opt => {
            const b = document.createElement('button'); b.innerText = opt.label;
            b.className = `action-btn btn-${opt.type}`;
            b.title = tagEngine(opt.text, eoc, userSettings);
            b.onclick = () => {
                if(opt.type !== 'exception') data.tree.push({ ...opt, children: [] });
                else data.tree.push({ ...opt, children: [] });
                if (opt.type === 'copy' && opt.text) navigator.clipboard.writeText(tagEngine(opt.text, eoc, userSettings));
                refreshUI();
            };
            btnBox.appendChild(b);
        });
      }
      
      const anbungaBox = document.getElementById('anbunga-container');
      if(eoc["_안분가"]) {
         anbungaBox.innerHTML = `<strong>안분가(비율):</strong> ${eoc["_안분가"]}`;
      } else {
         anbungaBox.innerHTML = '';
      }
    };

    function makeRow(label, value) {
        if(!value) value = ""; 
        const safeVal = String(value).replace(/'/g, "\\'");
        return `
        <div style="display:flex; justify-content:space-between; margin-bottom:2px; cursor:pointer;" 
             onclick="navigator.clipboard.writeText('${safeVal}')" title="클릭하여 복사">
            <span style="color:#666; font-weight:bold; min-width:60px;">${label}</span>
            <span style="color:#000; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;"> | ${value}</span>
        </div>`;
    }

    window.tagEngine = (text, data, settings) => {
      let res = text || "";
      res = res.replace(/{{상담사명}}/g, settings.name || "상담사");
      const combined = { ...(data.eoc원문 || {}), ...data };
      Object.entries(combined).forEach(([k, v]) => { res = res.replace(new RegExp(`{{${k}}}`, 'g'), typeof v === 'object' ? JSON.stringify(v) : v); });
      return res;
    };
    
    chrome.storage.local.get("userSettings", r => { 
        if(r.userSettings) { 
            userSettings = r.userSettings; 
            document.getElementById('set-name').value = userSettings.name||""; 
            document.getElementById('quick-buttons').value = JSON.stringify(userSettings.quickButtons||[], null, 2);
            document.getElementById('sms-templates').value = JSON.stringify(userSettings.smsTemplates||[], null, 2);
        }
        refreshUI();
    });
    chrome.storage.onChanged.addListener(c => { if(c.transfer_buffer) { ticketStore[getTid()].eoc = c.transfer_buffer.newValue; refreshUI(); } });
    setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; refreshUI(); } }, 1000);
    
    refreshUI();
  }
}
function getTid() { return location.pathname.match(/tickets\/(\d+)/)?.[1] || 'test-env'; }
