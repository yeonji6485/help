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
  return `${diffDays === 0 ? '오늘' : diffDays + '일 전'}, ${match[4]}시 ${match[5]}분`;
}

function parseEOCPage(doc) {
  const eoc원문 = {}; 
  const tags = {};

  // [1] 안전장치: 기존 모든 테이블 데이터를 자동으로 tags에 저장 (하위 호환성 100% 보장)
  // 코드가 줄어든 건 이 반복문 하나로 수백 줄의 노가다 코드를 대체했기 때문입니다!
  doc.querySelectorAll('.order-detail-table tr').forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2) {
      const key = cells[0].textContent.trim();
      const val = cells[1].textContent.trim();
      if (key && val) tags[key] = val.split('\n')[0]; // 기존 방식대로 첫 줄만 저장
    }
  });
  
  // [2] 신규 로직: 엑셀 분석 기반 정밀 파싱 (eoc원문 객체 생성)
  
  // 1. 주문정보
  const orderInfoCard = findCardByHeader(doc, '주문정보');
  if (orderInfoCard) {
    const orderType = findValueInTable(orderInfoCard, '주문 유형');
    if (orderType) eoc원문.배달유형 = orderType.includes('세이브') ? '무료배달' : '한집배달';
    
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
      eoc원문.픽업후갱신 = times.length > 0 ? times.join(', ') : '';
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

  // 2. 주문 메뉴
  const menuCard = findCardByHeader(doc, '주문 메뉴');
  if (menuCard) {
    const menuTable = menuCard.querySelector('.el-table__body');
    if (menuTable) {
      eoc원문.주문메뉴 = Array.from(menuTable.querySelectorAll('.el-table__row')).map(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length < 3) return '';
        return cells[2].textContent.trim().split('\n')
          .map(l => l.trim().startsWith('옵션:') ? '  ' + l.trim() : l.trim())
          .filter(l => l).join('\n');
      }).filter(v => v).join('\n\n');

      tags["_주문메뉴_목록"] = Array.from(menuTable.querySelectorAll('.el-table__row')).map(row => {
          const cells = row.querySelectorAll('.el-table__cell');
          return cells.length >= 3 ? {
              menuId: cells[0].textContent.trim(),
              price: cells[1].textContent.trim(),
              details: cells[2].textContent.trim()
          } : null;
      }).filter(v => v);
    }
  }

  // 3. 결제 및 쿠폰
  const paymentCard = findCardByHeader(doc, '결제');
  if (paymentCard) {
    let disc = 0, deliv = 0;
    const h4s = Array.from(paymentCard.querySelectorAll('h4')).find(h => h.textContent.includes('쿠폰'));
    if (h4s) {
      let next = h4s.nextElementSibling;
      while (next && !next.classList.contains('el-table')) next = next.nextElementSibling;
      if (next) {
        next.querySelectorAll('.el-table__row').forEach(row => {
          const cells = row.querySelectorAll('.el-table__cell');
          if (cells.length >= 3) {
            const type = cells[1].textContent.trim();
            const price = extractNumber(cells[2].textContent);
            if (type.includes('상품 할인') || type.includes('디쉬 할인')) disc += price;
            else if (type.includes('배달비')) deliv += price;
          }
        });
      }
    }
    eoc원문.할인금액 = disc;
    eoc원문.배달비 = deliv;
    tags["상품할인"] = disc; // 하위 호환성
  }

  // 4. 배달지
  const deliveryCard = findCardByHeader(doc, '배달지');
  if (deliveryCard) {
    eoc원문.고객전화 = (findValueInTable(deliveryCard, '전화번호') || '').split('\n')[0].trim();
    const road = findValueInTable(deliveryCard, '도로명 주소');
    const place = findValueInTable(deliveryCard, '지명');
    const detail = findValueInTable(deliveryCard, '상세 주소');
    eoc원문.배달지 = [road, (place && place !== road ? place : null), detail].filter(v => v).join(', ');
    const req = findValueInTable(deliveryCard, '선택된 배송요청사항');
    const memo = findValueInTable(deliveryCard, '비고');
    const tip = findValueInTable(deliveryCard, '배달팁');
    eoc원문.배달요청사항_비고_배달팁 = [req, memo, tip].filter(p => p && p.trim()).join(' / ');
    
    // 하위 호환성 (통합주소)
    tags["통합주소"] = eoc원문.배달지;
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
    eoc원문.배달파트너타입 = findValueInTable(courierCard, '쿠리어 타입');
  }

  // 7. 이슈 내용
  const issueCard = findCardByHeader(doc, '이슈 내용');
  if (issueCard) {
    const inquiryTime = findValueInTable(issueCard, '문의한 시간');
    if (inquiryTime) eoc원문.문의시각 = getRelativeDate(inquiryTime);
    eoc원문.문의유형 = findValueInTable(issueCard, '문의 유형');
    eoc원문.요청해결책 = findValueInTable(issueCard, '원하는 해결책');
    eoc원문.작성내용 = findValueInTable(issueCard, '작성내용');
  }

  // 8. 이력 (배달 완료 시각 추출)
  const historyCard = findCardByHeader(doc, '이력');
  if (historyCard) {
    const historyTable = historyCard.querySelector('.el-table__body');
    if (historyTable) {
      eoc원문.이력 = Array.from(historyTable.querySelectorAll('.el-table__row')).map(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length < 6) return null;
        const status = cells[2].textContent.trim();
        const createdText = cells[5].textContent.trim();
        const timeMatch = createdText.match(/(\d{2}):(\d{2}):(\d{2})/);
        if (timeMatch && status) {
          const h = parseInt(timeMatch[1]), m = parseInt(timeMatch[2]);
          if (status === '배달 완료') {
            const fullMatch = createdText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
            if (fullMatch) {
              tags["배달완료시각"] = `${fullMatch[4]}시 ${fullMatch[5]}분`;
              tags["_배달완료_시"] = fullMatch[4]; 
              tags["_배달완료_분"] = fullMatch[5];
            }
          }
          return { 상태: status, 시각_int: h * 60 + m, 시각_str: `${h}시 ${m}분` };
        }
        return null;
      }).filter(v => v);
    }
  }

  // [3] 최종 병합 및 계산
  Object.assign(tags, eoc원문);

  if (eoc원문.eta1_str) {
    tags["ETA1_시각"] = eoc원문.eta1_str;
    const [h, m] = eoc원문.eta1_str.replace('분','').split('시 ');
    tags["_ETA1_시"] = parseInt(h); 
    tags["_ETA1_분"] = parseInt(m);
  }

  if (tags["_ETA1_시"] && tags["_배달완료_시"]) {
    const eta1Mins = tags["_ETA1_시"] * 60 + tags["_ETA1_분"];
    const delivMins = parseInt(tags["_배달완료_시"]) * 60 + parseInt(tags["_배달완료_분"]);
    const diff = delivMins - eta1Mins;
    tags["배달시간차이"] = diff > 0 ? `+${diff}분` : `${diff}분`;
  }

  const salesPrice = eoc원문.판매가격 || 0;
  const productDiscount = eoc원문.할인금액 || 0;
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
    panel.id = 'zd-helper-panel'; panel.className = 'hover-mode';
    panel.innerHTML = `
      <div class="header">
        <span id="timer-display" style="font-weight:bold; color:blue; min-width:35px;">00:00</span>
        <span id="info-header">연동 대기 중...</span>
        <div><button id="home-btn">🏠</button><button id="pin-btn">📌</button><button id="stealth-btn">👻</button></div>
      </div>
      <div id="eoc-detail-view" class="tab-view stealth"></div>
      
      <div id="calculator-view" class="tab-view stealth">
        <div style="padding: 8px; font-size: 10px;">
          <h4 style="margin-bottom: 8px;">🧮 안분가 계산기</h4>
          <div id="calc-ratio-box" style="background: #f8f9fa; padding: 8px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 8px;">
            <div style="color:#666; font-size:9px;">데이터 로딩 중...</div>
          </div>
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 3px; font-size: 9px; color: #666;">보상금액 입력</label>
            <input id="calc-input" type="number" placeholder="예: 5000" style="width: 100%; padding: 6px; border: 1px solid #ccc; font-size: 11px; border-radius: 3px;">
          </div>
          <button id="calc-btn" style="width: 100%; padding: 8px; background: #32a1ce; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold;">계산하기</button>
          <div id="calc-result" style="margin-top: 10px; padding: 8px; background: #e8f5e9; border: 1px solid #4caf50; border-radius: 3px; font-weight: bold; text-align: center; display: none; font-size: 12px;"></div>
        </div>
      </div>

      <div id="settings-view" class="tab-view stealth">
        <input id="set-name" type="text" placeholder="상담사 이름" style="width:100%;">
        <textarea id="quick-buttons" style="width:100%; height:60px; margin-top:5px;" placeholder="퀵 버튼 JSON"></textarea>
        <button id="save-settings" style="width:100%; margin-top:5px; background:#32a1ce; color:white;">저장</button>
      </div>
      <div id="btn-container"></div><div id="anbunga-container"></div><div id="quick-btn-container"></div>
      <div class="footer"><button id="toggle-detail">EOC 정보</button><button id="toggle-calculator">🧮</button><button id="toggle-settings">⚙️ 설정</button></div>
      <div id="resize-handle"></div>
    `;
    document.body.appendChild(panel);

    // 이벤트 리스너 (드래그, 리사이징, 버튼)
    const resizeHandle = document.getElementById('resize-handle');
    let isResizing = false, startX, startY, startWidth, startHeight;
    resizeHandle.addEventListener('mousedown', (e) => { isResizing = true; startX = e.clientX; startY = e.clientY; startWidth = parseInt(getComputedStyle(panel).width); startHeight = parseInt(getComputedStyle(panel).height); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!isResizing) return; panel.style.width = Math.max(200, Math.min(800, startWidth - (e.clientX - startX))) + 'px'; panel.style.height = Math.max(200, Math.min(window.innerHeight - 100, startHeight + (e.clientY - startY))) + 'px'; });
    document.addEventListener('mouseup', () => { isResizing = false; });

    const header = panel.querySelector('.header');
    let isDragging = false, dragStartX, dragStartY, panelStartX, panelStartY;
    header.addEventListener('mousedown', (e) => { if(e.target.tagName === 'BUTTON') return; isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY; const rect = panel.getBoundingClientRect(); panelStartX = rect.left; panelStartY = rect.top; header.style.cursor = 'grabbing'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if(!isDragging) return; panel.style.left = Math.max(0, Math.min(panelStartX + (e.clientX - dragStartX), window.innerWidth - panel.offsetWidth)) + 'px'; panel.style.top = Math.max(0, Math.min(panelStartY + (e.clientY - dragStartY), window.innerHeight - panel.offsetHeight)) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { isDragging = false; header.style.cursor = 'move'; });

    document.getElementById('home-btn').onclick = () => { if(ticketStore[getTid()]) { ticketStore[getTid()].scenario = null; ticketStore[getTid()].tree = []; refreshUI(); }};
    document.getElementById('pin-btn').onclick = function() { panel.classList.toggle('pinned'); panel.classList.toggle('hover-mode'); this.style.background = panel.classList.contains('pinned') ? '#ffc107' : 'transparent'; };
    document.getElementById('stealth-btn').onclick = () => panel.classList.toggle('stealth');
    document.getElementById('toggle-detail').onclick = () => { document.getElementById('settings-view').classList.add('stealth'); document.getElementById('calculator-view').classList.add('stealth'); document.getElementById('eoc-detail-view').classList.toggle('stealth'); };
    document.getElementById('toggle-calculator').onclick = () => { document.getElementById('eoc-detail-view').classList.add('stealth'); document.getElementById('settings-view').classList.add('stealth'); document.getElementById('calculator-view').classList.toggle('stealth'); };
    document.getElementById('toggle-settings').onclick = () => { document.getElementById('eoc-detail-view').classList.add('stealth'); document.getElementById('calculator-view').classList.add('stealth'); document.getElementById('settings-view').classList.toggle('stealth'); };

    // 계산기 버튼 동작
    document.getElementById('calc-btn').onclick = () => {
      const eoc = ticketStore[getTid()]?.eoc?.eoc원문;
      if (!eoc || !eoc.판매가격) return alert('판매금액 데이터가 없습니다.');
      const sales = eoc.판매가격;
      const discount = eoc.할인금액 || 0;
      const inputVal = parseFloat(document.getElementById('calc-input').value);
      if(!inputVal) return alert('금액을 입력해주세요');
      const res = Math.round(((sales - discount) / sales) * inputVal);
      const resDiv = document.getElementById('calc-result');
      resDiv.innerText = `${res.toLocaleString()}원 (복사됨)`;
      resDiv.style.display = 'block';
      navigator.clipboard.writeText(res.toString());
    };

    document.getElementById('save-settings').onclick = () => {
      userSettings.name = document.getElementById('set-name').value;
      try { userSettings.quickButtons = JSON.parse(document.getElementById('quick-buttons').value || "[]"); } catch(e) { return alert("JSON 오류"); }
      chrome.storage.local.set({userSettings}); alert("저장됨"); renderQuickButtons(); refreshUI();
    };

    // UI 갱신 함수
    window.refreshUI = () => {
      const tid = getTid(); if (!tid) return;
      if (!ticketStore[tid]) ticketStore[tid] = { scenario: null, tree: [], eoc: {} };
      const data = ticketStore[tid], eoc = data.eoc || {};

      if (eoc["고유주문번호"]) {
        document.getElementById('info-header').innerText = `*${eoc["고유주문번호"].slice(-4)} | ${eoc["축약형주문번호"] || ""} | ${eoc["스토어명"] || ""}`;
      }

      const eocView = document.getElementById('eoc-detail-view');
      if (!data.eoc || Object.keys(data.eoc).length === 0) {
        eocView.innerHTML = '<div style="padding:4px; font-size:9px;">EOC 데이터 없음</div>';
      } else {
        const o = eoc.eoc원문 || {};
        const storePhone = (o.스토어번호 || "").replace(/-/g, "");
        const courierPhone = (o.배달파트너전화 || "").replace(/-/g, "");
        const custPhone = (o.고객전화 || "").replace(/-/g, "");

        eocView.innerHTML = `
          <div style="padding:2px; font-size:9px;">
            <div style="border:1px solid #ddd; padding:2px; margin-bottom:2px;">
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.배달유형}')"><strong>유형</strong> | ${o.배달유형}</div>
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.고유주문번호}')"><strong>고유</strong> | ${o.고유주문번호}</div>
            </div>
            <div style="border:1px solid #ddd; padding:2px; margin-bottom:2px;">
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.스토어명 ? o.스토어명.replace(/'/g, "\\'") : ""}')"><strong>매장</strong> | ${o.스토어명}</div>
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${storePhone}')"><strong>매장폰</strong> | ${storePhone}</div>
            </div>
            <div style="border:1px solid #ddd; padding:2px; margin-bottom:2px;">
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${courierPhone}')"><strong>기사폰</strong> | ${courierPhone}</div>
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${custPhone}')"><strong>고객폰</strong> | ${custPhone}</div>
            </div>
            <div style="border:1px solid #ddd; padding:2px;">
               <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.결제시각}')"><strong>결제</strong> | ${o.결제시각}</div>
               <div style="margin-top:2px; border-top:1px dashed #ccc;"><strong>메뉴</strong>: ${o.주문메뉴}</div>
               <div style="margin-top:2px;"><strong>판매가</strong>: ₩${(o.판매가격||0).toLocaleString()} | <strong>할인</strong>: ₩${(o.할인금액||0).toLocaleString()}</div>
            </div>
          </div>`;
      }

      // 계산기 정보 업데이트
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
            <div style="font-size:9px; color:#666; background:#fff; padding:4px; border-radius:2px;">
              (판매 ${s.toLocaleString()} - 할인 ${d.toLocaleString()}) ÷ ${s.toLocaleString()}
            </div>`;
        } else {
          calcBox.innerHTML = `<div style="color:#999; text-align:center;">데이터 대기 중...</div>`;
        }
      }

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
         anbungaBox.innerHTML = `<div style="padding:4px; font-size:10px; background:#f0f0f0; border-top:1px solid #ccc;"><strong>안분가(비율):</strong> ${eoc["_안분가"]}</div>`;
      } else {
         anbungaBox.innerHTML = '';
      }
    };

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
