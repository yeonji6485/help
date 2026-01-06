const isEOC = location.host.includes('coupang.net');
const isZD = location.host.includes('zendesk.com') || location.host.includes('google.com');

// ============================================================================
// [EOC] 데이터 수집 및 전송
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
    if (cells.length >= 2 && cells[0].textContent.trim() === labelText) {
      return cells[1].textContent.trim();
    }
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
  const orderDate = new Date(`${match[1]}-${match[2]}-${match[3]}`);
  const today = new Date();
  today.setHours(0, 0, 0, 0); orderDate.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today - orderDate) / (1000 * 60 * 60 * 24));
  const datePrefix = diffDays === 0 ? '오늘' : `${diffDays}일 전`;
  return `${datePrefix}, ${match[4]}시 ${match[5]}분`;
}

function parseEOCPage(doc) {
  const eoc원문 = {}; 
  const tags = {};

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
      if (m) {
        eoc원문.eta1_int = parseInt(m[1]) * 60 + parseInt(m[2]);
        eoc원문.eta1_str = `${m[1]}시 ${m[2]}분`;
      }
    }

    const eta3 = findValueInTable(orderInfoCard, 'ETA 3');
    if (eta3) {
      const times = [...eta3.matchAll(/(\d{2}):(\d{2})/g)].slice(1).map(m => `${m[1]}:${m[2]}`);
      eoc원문.픽업후갱신 = times.join(', ');
    }

    const payment = findValueInTable(orderInfoCard, '결제 금액');
    if (payment) {
      const pMatch = payment.match(/₩([\d,]+)/);
      if (pMatch) eoc원문.결제금액 = parseInt(pMatch[1].replace(/,/g, ''));
      const sMatch = payment.match(/판매가격:\s*₩([\d,]+)/);
      if (sMatch) eoc원문.판매가격 = parseInt(sMatch[1].replace(/,/g, ''));
    }

    const createTime = findValueInTable(orderInfoCard, '생성시간');
    if (createTime) eoc원문.결제시각 = getRelativeDate(createTime);
    eoc원문.스토어요청사항 = findValueInTable(orderInfoCard, '비고') || '';
  }

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
            if (line.startsWith('옵션:')) formatted += '  ' + line + '\n';
            else formatted += line + '\n';
          });
          menuList.push(formatted.trim());
          menuItemsLegacy.push({ menuId: cells[0].textContent.trim(), price: cells[1].textContent.trim(), details: cells[2].textContent.trim() });
        }
      });
      eoc원문.주문메뉴 = menuList.join('\n\n');
      tags["_주문메뉴_목록"] = menuItemsLegacy;
    }
  }

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
    eoc원문.할인금액 = disc;
    eoc원문.배달비 = delivDisc;
    tags["상품할인"] = disc;
  }

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

  const storeCard = findCardByHeader(doc, '스토어');
  if (storeCard) {
    eoc원문.머천트id = (findValueInTable(storeCard, '머천트 ID') || '').split('\n')[0].trim();
    eoc원문.스토어명 = (findValueInTable(storeCard, '이름') || '').split('\n')[0].trim();
    eoc원문.스토어번호 = (findValueInTable(storeCard, '전화번호') || '').split('\n')[0].trim();
    eoc원문.영업상태 = findValueInTable(storeCard, '영업 상태');
    const pos = findValueInTable(storeCard, 'POS 타입');
    if (pos) eoc원문.포스타입 = pos.toUpperCase().includes('COUPANG_POS') ? '쿠팡포스' : '쿠팡포스외';
  }

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

  const issueCard = findCardByHeader(doc, '이슈 내용');
  if (issueCard) {
    const inquiryTime = findValueInTable(issueCard, '문의한 시간');
    if (inquiryTime) eoc원문.문의시각 = getRelativeDate(inquiryTime);
    eoc원문.문의유형 = findValueInTable(issueCard, '문의 유형');
    eoc원문.요청해결책 = findValueInTable(issueCard, '원하는 해결책');
    eoc원문.작성내용 = findValueInTable(issueCard, '작성내용');
  }

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
            if (status.includes('픽업') || status.includes('Pick Up') || status.includes('배달 시작')) {
                tags["픽업시각"] = timeStr;
            }
            historyItems.push({ 상태: status, 시각_int: h * 60 + m, 시각_str: timeStr });
          }
        }
      });
      eoc원문.이력 = historyItems;
    }
  }

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
// [Zendesk] UI 및 태그 치환 엔진
// ============================================================================
if (isZD) {
  let ticketStore = {}, utteranceData = {}, userSettings = { name: "", quickButtons: [] }, lastPath = location.pathname;

  fetch(chrome.runtime.getURL('data_generated.json')).then(r => r.json()).then(data => { 
    utteranceData = data.scenarios; initUI(); 
  });

  function initUI() {
    const panel = document.createElement('div');
    panel.id = 'zd-helper-panel';
    // [CSS] Flex 레이아웃 적용, 고정 위치
    Object.assign(panel.style, {
        position: 'fixed', top: '10px', right: '10px', width: '320px',
        backgroundColor: '#fff', border: '1px solid #ccc',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: '9999',
        display: 'flex', flexDirection: 'column',
        maxHeight: '90vh', borderRadius: '4px'
    });

    panel.innerHTML = `
      <div class="header" style="padding:10px; background:#f5f5f5; border-bottom:1px solid #ddd; cursor:pointer; display:flex; justify-content:space-between; align-items:center; border-radius: 4px 4px 0 0;" title="클릭: 접기/펼치기 | 드래그: 이동">
        <div>
            <span id="timer-display" style="font-weight:bold; color:#0052cc; margin-right:8px; font-family: monospace;">00:00</span>
            <span id="info-header" style="font-size:11px; color:#333; font-weight:bold;">연동 대기 중...</span>
        </div>
        <div style="display:flex; gap:4px;">
            <button id="home-btn" title="처음으로" style="border:none; background:none; cursor:pointer; font-size:14px;">🏠</button>
        </div>
      </div>
      
      <div id="panel-content" style="display:flex; flex-direction:column; flex:1; overflow:hidden; background-color: #fff;">
        
        <div id="content-scroll-area" style="flex:1; overflow-y:auto; padding:0;">
            
            <div id="main-view-container">
                <div id="eoc-detail-view"></div>
                <div id="btn-container" style="padding:8px; border-top:1px solid #eee;"></div>
                <div id="anbunga-container"></div>
                <div id="quick-btn-container"></div>
            </div>
            
            <div id="calculator-view" style="display:none; padding:10px;">
                <h4 style="margin: 0 0 10px 0; font-size:12px; color:#333;">🧮 안분가 계산기</h4>
                <div id="calc-ratio-box" style="background: #f0f7ff; padding: 10px; border: 1px solid #cce5ff; border-radius: 4px; margin-bottom: 10px;">
                    <div style="color:#666; font-size:11px;">데이터 대기 중...</div>
                </div>
                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 11px; color: #555;">보상금액 입력</label>
                    <input id="calc-input" type="number" placeholder="예: 5000" style="width: 100%; padding: 8px; border: 1px solid #ddd; font-size: 12px; border-radius: 4px; box-sizing: border-box;">
                </div>
                <button id="calc-btn" style="width: 100%; padding: 8px; background: #0052cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">계산하기</button>
                <div id="calc-result" style="margin-top: 10px; padding: 10px; background: #e3fcef; border: 1px solid #c3e6cb; border-radius: 4px; font-weight: bold; text-align: center; display: none; font-size: 13px; color: #155724;"></div>
            </div>

            <div id="settings-view" style="display:none; padding:10px;">
                <label style="display:block; margin-bottom:4px; font-size:11px;">상담사 이름</label>
                <input id="set-name" type="text" placeholder="이름 입력" style="width:100%; padding:6px; margin-bottom:10px; border:1px solid #ddd; border-radius:4px; box-sizing: border-box;">
                <label style="display:block; margin-bottom:4px; font-size:11px;">퀵 버튼 JSON</label>
                <textarea id="quick-buttons" style="width:100%; height:80px; padding:6px; margin-bottom:10px; border:1px solid #ddd; border-radius:4px; box-sizing: border-box; font-family:monospace; font-size:11px;"></textarea>
                <button id="save-settings" style="width:100%; padding:8px; background: #0052cc; color: white; border: none; border-radius: 4px; cursor: pointer;">저장</button>
            </div>

        </div>

        <div class="footer" style="padding:0; display:flex; border-top:1px solid #ddd; background:#f9f9f9; height: 36px;">
            <button id="toggle-detail" class="footer-btn active" style="flex:1; border:none; background:none; cursor:pointer; font-size:11px; font-weight:bold; color:#333; border-right:1px solid #eee;">📋 정보/스크립트</button>
            <button id="toggle-calculator" class="footer-btn" style="flex:1; border:none; background:none; cursor:pointer; font-size:11px; color:#666; border-right:1px solid #eee;">🧮 계산기</button>
            <button id="toggle-settings" class="footer-btn" style="flex:1; border:none; background:none; cursor:pointer; font-size:11px; color:#666;">⚙️ 설정</button>
        </div>
      </div>
      <div id="resize-handle" style="height:12px; cursor:nwse-resize; position:absolute; bottom:0; right:0; width:12px; z-index:10000;"></div>
    `;
    document.body.appendChild(panel);

    const resizeHandle = document.getElementById('resize-handle');
    let isResizing = false; let startX, startY, startWidth, startHeight;
    resizeHandle.addEventListener('mousedown', (e) => { isResizing = true; startX = e.clientX; startY = e.clientY; startWidth = parseInt(getComputedStyle(panel).width); startHeight = parseInt(getComputedStyle(panel).height); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!isResizing) return; panel.style.width = Math.max(250, Math.min(800, startWidth - (e.clientX - startX))) + 'px'; panel.style.height = Math.max(200, Math.min(window.innerHeight - 50, startHeight + (e.clientY - startY))) + 'px'; });
    document.addEventListener('mouseup', () => { isResizing = false; });

    // 헤더 드래그 & 클릭 토글
    const header = panel.querySelector('.header');
    const contentPanel = document.getElementById('panel-content');
    let isDragging = false; let dragStartX, dragStartY, panelStartX, panelStartY;
    let isClick = true;

    header.addEventListener('mousedown', (e) => { 
      if(e.target.tagName === 'BUTTON') return; 
      isDragging = true; isClick = true;
      dragStartX = e.clientX; dragStartY = e.clientY; 
      const rect = panel.getBoundingClientRect(); panelStartX = rect.left; panelStartY = rect.top; 
      e.preventDefault(); 
    });
    
    document.addEventListener('mousemove', (e) => { 
      if(!isDragging) return; 
      if (Math.abs(e.clientX - dragStartX) > 5 || Math.abs(e.clientY - dragStartY) > 5) isClick = false;
      panel.style.left = Math.max(0, Math.min(panelStartX + (e.clientX - dragStartX), window.innerWidth - panel.offsetWidth)) + 'px'; 
      panel.style.top = Math.max(0, Math.min(panelStartY + (e.clientY - dragStartY), window.innerHeight - panel.offsetHeight)) + 'px'; 
      panel.style.right = 'auto'; 
    });
    
    document.addEventListener('mouseup', (e) => { 
      if (isDragging) {
        isDragging = false; header.style.cursor = 'move';
        if (isClick && !e.target.closest('button')) {
           if (contentPanel.style.display === 'none') {
             contentPanel.style.display = 'flex';
             panel.style.height = panel.dataset.prevHeight || 'auto';
             resizeHandle.style.display = 'block';
           } else {
             panel.dataset.prevHeight = getComputedStyle(panel).height;
             contentPanel.style.display = 'none';
             panel.style.height = 'auto';
             resizeHandle.style.display = 'none';
           }
        }
      }
    });

    document.getElementById('home-btn').onclick = () => { if(ticketStore[getTid()]) { ticketStore[getTid()].scenario = null; ticketStore[getTid()].tree = []; refreshUI(); }};
    
    // 탭 전환 로직 (스타일 업데이트 포함)
    function switchView(targetId, btnId) {
        ['main-view-container', 'calculator-view', 'settings-view'].forEach(id => document.getElementById(id).style.display = 'none');
        document.getElementById(targetId).style.display = 'block';
        
        // 버튼 스타일 업데이트
        document.querySelectorAll('.footer-btn').forEach(b => {
            b.style.fontWeight = 'normal'; b.style.color = '#666'; b.style.backgroundColor = 'transparent';
        });
        const activeBtn = document.getElementById(btnId);
        activeBtn.style.fontWeight = 'bold'; activeBtn.style.color = '#0052cc'; activeBtn.style.backgroundColor = '#f0f7ff';
    }

    document.getElementById('toggle-detail').onclick = () => switchView('main-view-container', 'toggle-detail');
    document.getElementById('toggle-calculator').onclick = () => switchView('calculator-view', 'toggle-calculator');
    document.getElementById('toggle-settings').onclick = () => switchView('settings-view', 'toggle-settings');

    document.getElementById('calc-btn').onclick = () => {
      const eoc = ticketStore[getTid()]?.eoc?.eoc원문;
      if (!eoc || !eoc.판매가격) return alert('판매금액 데이터가 없습니다.');
      const sales = eoc.판매가격;
      const discount = eoc.할인금액 || 0;
      const inputVal = parseFloat(document.getElementById('calc-input').value);
      if(!inputVal) return alert('금액을 입력해주세요');
      const res = Math.round(((sales - discount) / sales) * inputVal);
      document.getElementById('calc-result').innerText = `${res.toLocaleString()}원 (복사됨)`;
      document.getElementById('calc-result').style.display = 'block';
      navigator.clipboard.writeText(res.toString());
    };

    document.getElementById('save-settings').onclick = () => {
      userSettings.name = document.getElementById('set-name').value;
      try { userSettings.quickButtons = JSON.parse(document.getElementById('quick-buttons').value || "[]"); } catch(e) { return alert("JSON 오류"); }
      chrome.storage.local.set({userSettings}); alert("저장됨"); renderQuickButtons(); refreshUI();
    };

    // [핵심] UI 갱신
    window.refreshUI = () => {
      const tid = getTid(); if (!tid) return;
      if (!ticketStore[tid]) ticketStore[tid] = { scenario: null, tree: [], eoc: {} };
      const data = ticketStore[tid], eoc = data.eoc || {};

      if (eoc["고유주문번호"]) {
        document.getElementById('info-header').innerText = `*${eoc["고유주문번호"].slice(-4)} | ${eoc["축약형주문번호"] || ""} | ${eoc["스토어명"] || ""}`;
      }

      const eocView = document.getElementById('eoc-detail-view');
      if (!data.eoc || Object.keys(data.eoc).length === 0) {
        eocView.innerHTML = '<div style="padding:8px; font-size:11px; color:#666; text-align:center;">EOC 데이터가 없습니다.</div>';
      } else {
        const o = eoc.eoc원문 || {};
        const storePhone = (o.스토어번호 || "").replace(/-/g, "");
        const courierPhone = (o.배달파트너전화 || "").replace(/-/g, "");
        const pickupTime = eoc["픽업시각"] || "-";
        const completeTime = eoc["배달완료시각"] || "-";

        let delayInfo = "-";
        let delayColor = "#666";
        if (eoc["_ETA1_시"] !== undefined && eoc["_ETA1_분"] !== undefined) {
            const etaMinutes = eoc["_ETA1_시"] * 60 + eoc["_ETA1_분"];
            let currentMinutes = 0;
            if (eoc["_배달완료_시"]) {
                currentMinutes = parseInt(eoc["_배달완료_시"]) * 60 + parseInt(eoc["_배달완료_분"]);
                const diff = currentMinutes - etaMinutes;
                delayInfo = `${diff > 0 ? "+" : ""}${diff}분 (완료)`;
                delayColor = diff > 0 ? "#d32f2f" : "#1976d2";
            } else {
                const now = new Date();
                currentMinutes = now.getHours() * 60 + now.getMinutes();
                const diff = currentMinutes - etaMinutes;
                delayInfo = `${diff > 0 ? "+" : ""}${diff}분 (진행중)`;
                delayColor = diff > 0 ? "#d32f2f" : "#388e3c";
            }
        }

        let menuHtml = '';
        if (o.주문메뉴) {
            menuHtml = o.주문메뉴.split('\n').filter(l=>l.trim()).map(line => 
                `<div style="cursor:pointer; padding:2px 0; border-bottom:1px dashed #eee;" onclick="navigator.clipboard.writeText('${line.replace(/'/g, "\\'")}')" title="복사">
                   ${line}
                 </div>`
            ).join('');
        }

        eocView.innerHTML = `
          <div style="font-size: 11px; background: #fff;">
            <button id="toggle-raw-eoc" style="width:100%; border:none; border-bottom:1px solid #ddd; background:#f1f1f1; padding:6px; cursor:pointer; text-align:left; font-weight:bold; color:#333;">
              [EOC 원문 보기 ▼]
            </button>
            <div id="raw-eoc-data" style="display:none; max-height:200px; overflow-y:auto; background:#fafafa; border-bottom:1px solid #ddd; padding:6px;">
                <pre style="white-space:pre-wrap; font-size:10px; margin:0; color:#555;">${JSON.stringify(o, null, 2)}</pre>
            </div>

            <div style="padding: 8px; border-bottom: 1px solid #eee;">
               ${makeRow("주문유형", o.배달유형)}
               ${makeRow("고유번호", o.고유주문번호)}
               ${makeRow("매장명", o.스토어명)}
               ${makeRow("전화번호", storePhone)}
               ${makeRow("결제시각", o.결제시각)}
               ${makeRow("축약번호", o.축약형주문번호)}
            </div>

            <div style="padding: 8px; border-bottom: 1px solid #eee;">
               <div style="font-weight:bold; margin-bottom:4px; color:#333;">주문 메뉴</div>
               <div style="color:#555; line-height:1.4;">${menuHtml || '정보 없음'}</div>
            </div>

            <div style="padding: 8px; border-bottom: 1px solid #eee;">
               ${makeRow("판매가격", o.판매가격 ? `₩${o.판매가격.toLocaleString()}` : "")}
               ${makeRow("상품할인", o.할인금액 ? `₩${o.할인금액.toLocaleString()}` : "₩0")}
            </div>

            <div style="padding: 8px;">
               ${makeRow("파트너유형", o.배달파트너타입)}
               ${makeRow("파트너ID", o.배달파트너id)}
               ${makeRow("파트너전화", courierPhone)}
               <div style="margin-top:6px; padding-top:6px; border-top:1px dashed #ddd;">
                 ${makeRow("픽업시각", pickupTime)}
                 ${makeRow("완료시각", completeTime)}
                 <div style="display:flex; justify-content:flex-start; margin-bottom:2px;">
                    <span style="color:#666; font-weight:bold; min-width:70px;">지연경과</span>
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

      // 계산기 비율 업데이트
      const calcBox = document.getElementById('calc-ratio-box');
      if (calcBox) {
        if (eoc.eoc원문 && eoc.eoc원문.판매가격) {
          const s = eoc.eoc원문.판매가격;
          const d = eoc.eoc원문.할인금액 || 0;
          const ratio = ((s - d) / s * 100).toFixed(2);
          calcBox.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-weight:bold; color:#333;">적용 비율:</span>
              <span style="font-weight:bold; color:#d32f2f; font-size:12px;">${ratio}%</span>
            </div>
            <div style="font-size:10px; color:#666; background:#fff; padding:6px; border-radius:4px; border:1px solid #eee;">
              (판매 ${s.toLocaleString()} - 할인 ${d.toLocaleString()}) ÷ ${s.toLocaleString()}
            </div>`;
        } else {
          calcBox.innerHTML = `<div style="color:#999; text-align:center;">판매 데이터가 없습니다.</div>`;
        }
      }

      // [버튼 렌더링 - 여기가 누락되었던 핵심 부분]
      const btnBox = document.getElementById('btn-container'); btnBox.innerHTML = '';
      if (!data.scenario) {
        Object.keys(utteranceData).forEach(cat => {
          const b = document.createElement('button'); b.className = 'action-btn'; b.innerText = cat;
          b.onclick = () => { data.scenario = cat; data.tree = []; refreshUI(); };
          btnBox.appendChild(b);
        });
      } else {
        const renderTree = (tree) => {
          tree.forEach((n, idx) => {
            const b = document.createElement('button'); b.className = `action-btn btn-${n.type}`; b.innerText = n.label;
            b.onclick = () => { tree.splice(idx + 1); refreshUI(); };
            btnBox.appendChild(b);
            const m = document.createElement('div'); m.className = 'branch-marker'; btnBox.appendChild(m);
          });
        };
        renderTree(data.tree);
        const current = data.tree.length === 0 ? 'start' : data.tree[data.tree.length - 1].next;
        const options = utteranceData[data.scenario][current] || [];
        if(options.length > 0) { const m = document.createElement('div'); m.className = 'branch-marker'; btnBox.appendChild(m); }
        options.forEach(opt => {
          const b = document.createElement('button'); b.className = `action-btn btn-${opt.type}`; b.innerText = opt.label;
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
      renderQuickButtons();

      const anbungaBox = document.getElementById('anbunga-container');
      if(eoc["_안분가"]) {
         anbungaBox.innerHTML = `<div style="padding:8px; font-size:11px; background:#fffbe6; border:1px solid #ffe58f; border-radius:4px; margin: 8px; text-align:center;"><strong>안분가(비율):</strong> ${eoc["_안분가"]}</div>`;
      } else {
         anbungaBox.innerHTML = '';
      }
    };

    function makeRow(label, value) {
        if(!value) value = ""; 
        const safeVal = String(value).replace(/'/g, "\\'");
        return `
        <div style="display:flex; justify-content:flex-start; margin-bottom:4px; cursor:pointer;" 
             onclick="navigator.clipboard.writeText('${safeVal}')" title="클릭하여 복사">
            <span style="color:#666; font-weight:bold; min-width:70px; display:inline-block;">${label}</span>
            <span style="color:#000; margin-left:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:210px;">| ${value}</span>
        </div>`;
    }

    window.tagEngine = (text, data, settings) => {
      let res = text || "";
      res = res.replace(/{{상담사명}}/g, settings.name || "상담사");
      const combined = { ...(data.eoc원문 || {}), ...data };
      Object.entries(combined).forEach(([k, v]) => { res = res.replace(new RegExp(`{{${k}}}`, 'g'), typeof v === 'object' ? JSON.stringify(v) : v); });
      return res;
    };
    window.renderQuickButtons = () => {
       const qBox = document.getElementById('quick-btn-container'); qBox.innerHTML = '';
       (userSettings.quickButtons||[]).forEach(qb => {
          const b = document.createElement('button'); b.className = 'action-btn btn-quick'; b.innerText = qb.label;
          b.onclick = () => navigator.clipboard.writeText(tagEngine(qb.text, ticketStore[getTid()]?.eoc || {}, userSettings));
          qBox.appendChild(b);
       });
    };
    
    chrome.storage.local.get("userSettings", r => { if(r.userSettings) { userSettings = r.userSettings; document.getElementById('set-name').value = userSettings.name||""; document.getElementById('quick-buttons').value = JSON.stringify(userSettings.quickButtons||[]); renderQuickButtons();} });
    chrome.storage.onChanged.addListener(c => { if(c.transfer_buffer) { ticketStore[getTid()].eoc = c.transfer_buffer.newValue; refreshUI(); } });
    setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; refreshUI(); } }, 1000);
    
    refreshUI();
  }
}
function getTid() { return location.pathname.match(/tickets\/(\d+)/)?.[1] || 'test-env'; }
