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

/**
 * [핵심] EOC 페이지 파싱 (엑셀 명세 반영)
 */
function parseEOCPage(doc) {
  const eoc원문 = {};
  const tags = {};
  
  // 1. 주문정보
  const orderInfoCard = findCardByHeader(doc, '주문정보');
  if (orderInfoCard) {
    const orderType = findValueInTable(orderInfoCard, '주문 유형');
    if (orderType) eoc원문.배달유형 = orderType.includes('세이브 배달') ? '무료배달' : '한집배달';
    
    eoc원문.축약형주문번호 = (findValueInTable(orderInfoCard, '축약형 주문 ID') || '').split('\n')[0].trim();
    eoc원문.고유주문번호 = (findValueInTable(orderInfoCard, '고유 주문 ID') || '').split('\n')[0].trim();
    eoc원문.스토어id = (findValueInTable(orderInfoCard, '스토어 ID') || '').split('\n')[0].trim();
    eoc원문.회원번호 = (findValueInTable(orderInfoCard, '회원 번호') || '').split('\n')[0].trim();
    eoc원문.상태 = findValueInTable(orderInfoCard, '상태');
    
    // [추가] 조리 시간 관련
    eoc원문.예상조리소요시간 = findValueInTable(orderInfoCard, 'Merchant Input (Excludes merchant delay)');
    eoc원문.조리지연 = findValueInTable(orderInfoCard, 'Merchant Delay');

    // ETA 1
    const eta1 = findValueInTable(orderInfoCard, 'ETA 1');
    if (eta1) {
      const timeMatch = eta1.match(/최초시간\s+(\d{2}):(\d{2})/);
      if (timeMatch) {
        eoc원문.eta1_int = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
        eoc원문.eta1_str = `${timeMatch[1]}시 ${timeMatch[2]}분`;
      }
    }
    
    // ETA 3 (픽업 후 갱신)
    const eta3 = findValueInTable(orderInfoCard, 'ETA 3');
    if (eta3) {
      const times = [...eta3.matchAll(/(\d{2}):(\d{2})/g)];
      // 첫 번째는 최초시간이므로 제외하고 갱신된 시간들만
      const updateTimes = [];
      for (let i = 1; i < times.length; i++) {
        updateTimes.push(`${times[i][1]}:${times[i][2]}`);
      }
      eoc원문.픽업후갱신 = updateTimes.join(', ');
    }
    
    // 결제금액 및 판매가격
    const payment = findValueInTable(orderInfoCard, '결제 금액');
    if (payment) {
      const paymentMatch = payment.match(/₩([\d,]+)/);
      if (paymentMatch) eoc원문.결제금액 = parseInt(paymentMatch[1].replace(/,/g, ''));
      
      const salePriceMatch = payment.match(/판매가격:\s*₩([\d,]+)/);
      if (salePriceMatch) eoc원문.판매가격 = parseInt(salePriceMatch[1].replace(/,/g, ''));
    }
    
    const createTime = findValueInTable(orderInfoCard, '생성시간');
    if (createTime) eoc원문.결제시각 = getRelativeDate(createTime);
    eoc원문.스토어요청사항 = findValueInTable(orderInfoCard, '비고') || '';
  }
  
  // 2. 주문메뉴
  const menuCard = findCardByHeader(doc, '주문 메뉴');
  if (menuCard) {
    const menuTable = menuCard.querySelector('.el-table__body');
    if (menuTable) {
      const menuRows = menuTable.querySelectorAll('.el-table__row');
      const menuItems = [];
      
      menuRows.forEach(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length >= 3) {
          const menuText = cells[2].textContent.trim();
          const lines = menuText.split('\n').filter(l => l.trim());
          let formattedMenu = '';
          lines.forEach(line => {
            line = line.trim();
            if (line) {
              if (line.startsWith('옵션:')) formattedMenu += '  ' + line + '\n';
              else formattedMenu += line + '\n';
            }
          });
          menuItems.push(formattedMenu.trim());
        }
      });
      eoc원문.주문메뉴 = menuItems.join('\n\n');
      
      // 하위 호환성 (tags._주문메뉴_목록)
      tags["_주문메뉴_목록"] = Array.from(menuRows).map(row => {
          const cells = row.querySelectorAll('.el-table__cell');
          return cells.length >= 3 ? {
              menuId: cells[0].textContent.trim(),
              price: cells[1].textContent.trim(),
              details: cells[2].textContent.trim()
          } : null;
      }).filter(Boolean);
    }
  }
  
  // 3. 결제 (쿠폰)
  const paymentCard = findCardByHeader(doc, '결제');
  if (paymentCard) {
    let 할인금액합계 = 0;
    let 배달비할인 = 0;
    
    const headers = paymentCard.querySelectorAll('h4');
    for (const header of headers) {
      if (header.textContent.includes('쿠폰')) {
        let nextEl = header.nextElementSibling;
        while (nextEl && !nextEl.classList.contains('el-table')) {
          nextEl = nextEl.nextElementSibling;
        }
        
        if (nextEl && nextEl.classList.contains('el-table')) {
          const tbody = nextEl.querySelector('.el-table__body');
          if (tbody) {
            const rows = tbody.querySelectorAll('.el-table__row');
            rows.forEach(row => {
              const cells = row.querySelectorAll('.el-table__cell');
              if (cells.length >= 3) {
                const 할인유형 = cells[1].textContent.trim();
                const 가격 = extractNumber(cells[2].textContent.trim());
                
                if (할인유형.includes('상품 할인') || 할인유형.includes('디쉬 할인')) {
                  할인금액합계 += 가격;
                } else if (할인유형.includes('배달비')) {
                  배달비할인 = 가격;
                }
              }
            });
          }
        }
        break;
      }
    }
    eoc원문.할인금액 = 할인금액합계;
    eoc원문.배달비 = 배달비할인;
    tags["상품할인"] = 할인금액합계; // 하위 호환
  }
  
  // 4. 배달지
  const deliveryCard = findCardByHeader(doc, '배달지');
  if (deliveryCard) {
    eoc원문.고객전화 = (findValueInTable(deliveryCard, '전화번호') || '').split('\n')[0].trim();
    
    const roadAddr = findValueInTable(deliveryCard, '도로명 주소');
    const placeName = findValueInTable(deliveryCard, '지명');
    const detailAddr = findValueInTable(deliveryCard, '상세 주소');
    
    const addressParts = [];
    if (roadAddr) {
      addressParts.push(roadAddr);
      if (placeName && placeName !== roadAddr) addressParts.push(placeName);
    } else if (placeName) {
      addressParts.push(placeName);
    }
    if (detailAddr) addressParts.push(detailAddr);
    eoc원문.배달지 = addressParts.join(', ');
    tags["통합주소"] = eoc원문.배달지; // 하위 호환
    
    const deliveryReq = findValueInTable(deliveryCard, '선택된 배송요청사항') || '';
    const deliveryMemo = findValueInTable(deliveryCard, '비고') || '';
    const deliveryTip = findValueInTable(deliveryCard, '배달팁') || '';
    const reqParts = [deliveryReq, deliveryMemo, deliveryTip].filter(p => p && p.trim());
    eoc원문.배달요청사항_비고_배달팁 = reqParts.join(' / ');
  }
  
  // 5. 스토어
  const storeCard = findCardByHeader(doc, '스토어');
  if (storeCard) {
    eoc원문.머천트id = (findValueInTable(storeCard, '머천트 ID') || '').split('\n')[0].trim();
    eoc원문.스토어명 = (findValueInTable(storeCard, '이름') || '').split('\n')[0].trim();
    eoc원문.스토어번호 = (findValueInTable(storeCard, '전화번호') || '').split('\n')[0].trim(); // [분리]
    eoc원문.영업상태 = findValueInTable(storeCard, '영업 상태');
    const posType = findValueInTable(storeCard, 'POS 타입');
    if (posType) eoc원문.포스타입 = posType.toUpperCase().includes('COUPANG_POS') ? '쿠팡포스' : '쿠팡포스외';
  }
  
  // 6. 쿠리어
  const courierCard = findCardByHeader(doc, '쿠리어');
  if (courierCard) {
    eoc원문.배달파트너id = (findValueInTable(courierCard, '쿠리어 ID') || '').split('\n')[0].trim();
    eoc원문.배달파트너전화 = (findValueInTable(courierCard, '전화번호') || '').split('\n')[0].trim(); // [분리]
    eoc원문.배달유형_쿠리어 = findValueInTable(courierCard, '배달 유형');
    eoc원문.배달파트너타입 = findValueInTable(courierCard, '쿠리어 타입');
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
  
  // 8. 이력 (배달완료 시각)
  const historyCard = findCardByHeader(doc, '이력');
  if (historyCard) {
    const historyTable = historyCard.querySelector('.el-table__body');
    if (historyTable) {
      const historyRows = historyTable.querySelectorAll('.el-table__row');
      const historyItems = [];
      
      historyRows.forEach(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length >= 6) {
          const 상태 = cells[2].textContent.trim();
          const 생성ID = cells[5].textContent.trim();
          const timeMatch = 생성ID.match(/(\d{2}):(\d{2}):(\d{2})/);
          
          if (timeMatch && 상태) {
            const hour = parseInt(timeMatch[1]);
            const min = parseInt(timeMatch[2]);
            
            // 배달 완료 시각 추출
            if (상태 === '배달 완료') {
                const fullMatch = 생성ID.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
                if(fullMatch) {
                    tags["배달완료시각"] = `${fullMatch[4]}시 ${fullMatch[5]}분`;
                    tags["_배달완료_시"] = fullMatch[4];
                    tags["_배달완료_분"] = fullMatch[5];
                }
            }

            historyItems.push({
              상태: 상태,
              시각_int: hour * 60 + min,
              시각_str: `${hour}시 ${min}분`
            });
          }
        }
      });
      eoc원문.이력 = historyItems;
    }
  }
  
  // [보완] 기존 로직 (안전장치 - 모든 테이블 값 저장)
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

  // [병합 및 계산]
  Object.assign(tags, eoc원문);

  if (eoc원문.eta1_str) {
    tags["ETA1_시각"] = eoc원문.eta1_str;
    const [h, m] = eoc원문.eta1_str.replace('분','').split('시 ');
    tags["_ETA1_시"] = parseInt(h); tags["_ETA1_분"] = parseInt(m);
  }

  if (tags["_ETA1_시"] && tags["_배달완료_시"]) {
    const eta1Mins = tags["_ETA1_시"] * 60 + tags["_ETA1_분"];
    const deliveryMinutes = parseInt(tags["_배달완료_시"]) * 60 + parseInt(tags["_배달완료_분"]);
    const diffMinutes = deliveryMinutes - eta1Mins;
    tags["배달시간차이"] = diffMinutes > 0 ? `+${diffMinutes}분` : `${diffMinutes}분`;
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

function isTimePassed(t) {
  if(!t || !t.includes(':')) return false;
  const now = new Date();
  const [h, m] = t.split(':').map(Number);
  const target = new Date(); 
  target.setHours(h, m, 0);
  return now > target;
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
            <div style="color:#666; font-size:9px;">데이터 대기 중...</div>
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

    const resizeHandle = document.getElementById('resize-handle');
    let isResizing = false; let startX, startY, startWidth, startHeight;
    resizeHandle.addEventListener('mousedown', (e) => { isResizing = true; startX = e.clientX; startY = e.clientY; startWidth = parseInt(getComputedStyle(panel).width); startHeight = parseInt(getComputedStyle(panel).height); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!isResizing) return; panel.style.width = Math.max(200, Math.min(800, startWidth - (e.clientX - startX))) + 'px'; panel.style.height = Math.max(200, Math.min(window.innerHeight - 100, startHeight + (e.clientY - startY))) + 'px'; });
    document.addEventListener('mouseup', () => { isResizing = false; });

    const header = panel.querySelector('.header');
    let isDragging = false; let dragStartX, dragStartY, panelStartX, panelStartY;
    header.addEventListener('mousedown', (e) => { if(e.target.tagName === 'BUTTON') return; isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY; const rect = panel.getBoundingClientRect(); panelStartX = rect.left; panelStartY = rect.top; header.style.cursor = 'grabbing'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if(!isDragging) return; panel.style.left = Math.max(0, Math.min(panelStartX + (e.clientX - dragStartX), window.innerWidth - panel.offsetWidth)) + 'px'; panel.style.top = Math.max(0, Math.min(panelStartY + (e.clientY - dragStartY), window.innerHeight - panel.offsetHeight)) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { isDragging = false; header.style.cursor = 'move'; });

    document.getElementById('home-btn').onclick = () => { if(ticketStore[getTid()]) { ticketStore[getTid()].scenario = null; ticketStore[getTid()].tree = []; refreshUI(); }};
    document.getElementById('pin-btn').onclick = function() { panel.classList.toggle('pinned'); panel.classList.toggle('hover-mode'); this.style.background = panel.classList.contains('pinned') ? '#ffc107' : 'transparent'; };
    document.getElementById('stealth-btn').onclick = () => panel.classList.toggle('stealth');
    document.getElementById('toggle-detail').onclick = () => { document.getElementById('settings-view').classList.add('stealth'); document.getElementById('calculator-view').classList.add('stealth'); document.getElementById('eoc-detail-view').classList.toggle('stealth'); };
    document.getElementById('toggle-calculator').onclick = () => { document.getElementById('eoc-detail-view').classList.add('stealth'); document.getElementById('settings-view').classList.add('stealth'); document.getElementById('calculator-view').classList.toggle('stealth'); };
    document.getElementById('toggle-settings').onclick = () => { document.getElementById('eoc-detail-view').classList.add('stealth'); document.getElementById('calculator-view').classList.add('stealth'); document.getElementById('settings-view').classList.toggle('stealth'); };

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

    // [UI 디자인 수정] 와이어프레임 100% 반영 및 클릭 복사 적용
    window.refreshUI = function() {
      const tid = getTid(); if (!tid) return;
      if (!ticketStore[tid]) ticketStore[tid] = { scenario: null, tree: [], eoc: {} };
      const data = ticketStore[tid], eoc = data.eoc || {};

      // 헤더 업데이트
      if (eoc["고유주문번호"]) {
        document.getElementById('info-header').innerText = `*${eoc["고유주문번호"].slice(-4)} | ${eoc["축약형주문번호"] || ""} | ${eoc["스토어명"] || ""}`;
      }

      // EOC 뷰 업데이트
      const eocView = document.getElementById('eoc-detail-view');
      
      // [1] 데이터 없음
      if (!data.eoc || Object.keys(data.eoc).length === 0) {
        eocView.innerHTML = '<div style="padding:4px; font-size:9px;">EOC 데이터 없음</div>';
      } 
      // [2] 데이터 있음 (디자인 적용)
      else {
        const o = eoc.eoc원문 || {};
        
        // 전화번호 하이픈 제거
        const storePhone = (o.스토어번호 || "").replace(/-/g, "");
        const courierPhone = (o.배달파트너전화 || "").replace(/-/g, "");
        
        // 메뉴 리스트 HTML 생성 (각 줄마다 복사 가능하게)
        let menuHtml = '';
        if (o.주문메뉴) {
            menuHtml = o.주문메뉴.split('\n').filter(line => line.trim()).map(line => 
                `<div class="copyable-row" style="cursor:pointer; padding:1px 0;" onclick="navigator.clipboard.writeText('${line.replace(/'/g, "\\'")}')" title="클릭하여 복사">
                   ${line}
                 </div>`
            ).join('');
        }

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
               <div style="color:#444; line-height:1.4;">
                 ${menuHtml || '정보 없음'}
               </div>
            </div>

            <div style="padding: 6px; border-bottom: 1px solid #ccc;">
               ${makeRow("판매가격", o.판매가격 ? `₩${o.판매가격.toLocaleString()}` : "")}
               ${makeRow("상품할인", o.할인금액 ? `₩${o.할인금액.toLocaleString()}` : "₩0")}
            </div>

            <div style="padding: 6px;">
               ${makeRow("파트너유형", o.배달파트너타입)}
               ${makeRow("파트너ID", o.배달파트너id)}
               ${makeRow("파트너전화", courierPhone)}
            </div>
          </div>`;
          
          // 토글 기능 바인딩
          document.getElementById('toggle-raw-eoc').onclick = function() {
            const el = document.getElementById('raw-eoc-data');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
          };
      }

      // [3] 계산기 (비율 자동 갱신)
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

      // 버튼 트리 렌더링
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

    // 헬퍼: 행 생성기 (클릭 시 복사 기능 내장)
    function makeRow(label, value) {
        if(!value) value = ""; 
        // 텍스트 내 따옴표 이스케이프 처리
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
