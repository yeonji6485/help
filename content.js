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

/** 헬퍼: 카드 헤더 찾기 */
function findCardByHeader(doc, headerText) {
  const cards = doc.querySelectorAll('.order-detail-card');
  for (const card of cards) {
    const header = card.querySelector('.el-card__header .clearfix span');
    if (header && header.textContent.trim() === headerText) return card;
  }
  return null;
}

/** 헬퍼: 테이블 값 찾기 */
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

/** 헬퍼: 숫자 추출 */
function extractNumber(text) {
  if (!text) return 0;
  return parseInt(text.replace(/[^\d]/g, '')) || 0;
}

/** 헬퍼: 날짜 상대 표현 */
function getRelativeDate(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return '';
  
  const orderDate = new Date(`${match[1]}-${match[2]}-${match[3]}`);
  const today = new Date();
  today.setHours(0, 0, 0, 0); 
  orderDate.setHours(0, 0, 0, 0);
  
  const diffDays = Math.floor((today - orderDate) / (1000 * 60 * 60 * 24));
  return `${diffDays === 0 ? '오늘' : diffDays + '일 전'}, ${match[4]}시 ${match[5]}분`;
}

/**
 * [핵심] EOC 페이지 파싱 (엑셀 기준 개선된 로직)
 */
function parseEOCPage(doc) {
  const eoc원문 = {}; // 신규 로직용 변수
  const tags = {};    // 기존 UI 호환용 변수
  
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

    // ETA1
    const eta1 = findValueInTable(orderInfoCard, 'ETA 1');
    if (eta1) {
      const m = eta1.match(/최초시간\s+(\d{2}):(\d{2})/);
      if (m) {
        eoc원문.eta1_int = parseInt(m[1]) * 60 + parseInt(m[2]);
        eoc원문.eta1_str = `${m[1]}시 ${m[2]}분`;
      }
    }

    // ETA3 (픽업 후 갱신)
    const eta3 = findValueInTable(orderInfoCard, 'ETA 3');
    if (eta3) {
      const times = [...eta3.matchAll(/(\d{2}):(\d{2})/g)].slice(1).map(m => `${m[1]}:${m[2]}`);
      eoc원문.픽업후갱신 = times.join(', ');
    }

    // 결제금액
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
      }).join('\n\n');
      
      // 기존 로직 호환 (메뉴 목록 배열)
      const menuItems = Array.from(menuTable.querySelectorAll('.el-table__row')).map(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length < 3) return null;
        return {
           menuId: cells[0].textContent.trim(),
           price: cells[1].textContent.trim(),
           details: cells[2].textContent.trim()
        };
      }).filter(Boolean);
      if(menuItems.length > 0) tags["_주문메뉴_목록"] = menuItems;
    }
  }

  // 3. 결제 (쿠폰 및 배달비)
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
  }

  // 4. 배달지
  const deliveryCard = findCardByHeader(doc, '배달지');
  if (deliveryCard) {
    eoc원문.고객전화 = (findValueInTable(deliveryCard, '전화번호') || '').split('\n')[0].trim();
    const road = findValueInTable(deliveryCard, '도로명 주소');
    const place = findValueInTable(deliveryCard, '지명');
    const detail = findValueInTable(deliveryCard, '상세 주소');
    eoc원문.배달지 = [road, (place && place !== road ? place : null), detail].filter(Boolean).join(', ');
    
    const req = findValueInTable(deliveryCard, '선택된 배송요청사항');
    const memo = findValueInTable(deliveryCard, '비고');
    const tip = findValueInTable(deliveryCard, '배달팁');
    eoc원문.배달요청사항_비고_배달팁 = [req, memo, tip].filter(p => p && p.trim()).join(' / ');
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
    const time = findValueInTable(issueCard, '문의한 시간');
    if (time) eoc원문.문의시각 = getRelativeDate(time);
    eoc원문.문의유형 = findValueInTable(issueCard, '문의 유형');
    eoc원문.요청해결책 = findValueInTable(issueCard, '원하는 해결책');
    eoc원문.작성내용 = findValueInTable(issueCard, '작성내용');
  }

  // 8. 이력 (배달완료 시각 추출)
  const historyCard = findCardByHeader(doc, '이력');
  if (historyCard) {
    const table = historyCard.querySelector('.el-table__body');
    if (table) {
      eoc원문.이력 = Array.from(table.querySelectorAll('.el-table__row')).map(row => {
        const cells = row.querySelectorAll('.el-table__cell');
        if (cells.length < 6) return null;
        const status = cells[2].textContent.trim();
        const created = cells[5].textContent.trim();
        const m = created.match(/(\d{2}):(\d{2}):(\d{2})/);
        
        if (m && status) {
          // 배달 완료 시각 추출 (계산용)
          if (status === '배달 완료') {
            const fm = created.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
            if (fm) {
              tags["배달완료시각"] = `${fm[4]}시 ${fm[5]}분`;
              tags["_배달완료_시"] = fm[4]; 
              tags["_배달완료_분"] = fm[5];
            }
          }
          return { 상태: status, 시각_str: `${parseInt(m[1])}시 ${parseInt(m[2])}분` };
        }
        return null;
      }).filter(Boolean);
    }
  }
  
  // 9. 보상내역 (기존 로직 유지)
  const compensationCard = findCardByHeader(doc, '보상내역');
  if (compensationCard) {
    const rows = compensationCard.querySelectorAll('.el-table__body tbody tr');
    const items = Array.from(rows).map(row => {
      const c = row.querySelectorAll('td');
      return c.length >= 5 ? { reason: c[0].textContent.trim(), amount: c[1].textContent.trim(), processor: c[2].textContent.trim(), processedAt: c[3].textContent.trim(), status: c[4].textContent.trim() } : null;
    }).filter(Boolean);
    if(items.length > 0) tags["_보상내역"] = items;
  }

  // ============================================
  // [중요] 하위 호환성 유지 루프
  // (UI가 '고유 주문 ID' 같은 옛날 키를 찾을 수 있게 함)
  // ============================================
  [orderInfoCard, paymentCard, deliveryCard, findCardByHeader(doc, '배달 작업'), storeCard, courierCard].forEach(card => {
    if (!card) return;
    card.querySelectorAll('.order-detail-table tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const k = cells[0].textContent.trim();
        const v = cells[1].textContent.trim();
        if (k && v) tags[k] = v.split('\n')[0];
      }
    });
  });

  // ============================================
  // [계산] 배달시간차이 & 안분가
  // ============================================
  if (eoc원문.eta1_str) {
    tags["ETA1_시각"] = eoc원문.eta1_str;
    const [h, m] = eoc원문.eta1_str.replace('분','').split('시 ');
    tags["_ETA1_시"] = parseInt(h); 
    tags["_ETA1_분"] = parseInt(m);
  }

  if (tags["_ETA1_시"] && tags["_배달완료_시"]) {
    const etaMins = tags["_ETA1_시"] * 60 + tags["_ETA1_분"];
    const delMins = parseInt(tags["_배달완료_시"]) * 60 + parseInt(tags["_배달완료_분"]);
    const diff = delMins - etaMins;
    tags["배달시간차이"] = diff > 0 ? `+${diff}분` : `${diff}분`;
  }
  
  const sales = eoc원문.판매가격 || 0;
  const discount = eoc원문.할인금액 || 0;
  if (sales > 0) {
    tags["_안분가"] = `${((sales - discount) / sales * 100).toFixed(2)}%`;
    tags["_판매금액_숫자"] = sales; 
    tags["_상품할인_숫자"] = discount;
  }

  // 최종 병합
  tags.eoc원문 = eoc원문;
  // 호환성: eoc원문의 키들도 tags 최상위에 일부 노출 (선택사항, 안전장치)
  Object.assign(tags, eoc원문);

  return tags;
}

function isTimePassed(t) {
  if(!t || !t.includes(':')) return false;
  const now = new Date(); const [h, m] = t.split(':').map(Number);
  const target = new Date(); target.setHours(h, m, 0);
  return now > target;
}

// ============================================================================
// [Zendesk] UI 및 태그 치환 엔진 (기존 기능 100% 유지)
// ============================================================================
if (isZD) {
  let ticketStore = {};
  let utteranceData = {};
  let userSettings = { name: "" };
  let lastPath = location.pathname;

  fetch(chrome.runtime.getURL('data_generated.json'))
    .then(r => r.json())
    .then(data => { 
      utteranceData = data.scenarios; 
      if (!userSettings.name) userSettings.name = "";
      if (!userSettings.quickButtons) userSettings.quickButtons = [];
      initUI(); 
    });

  function initUI() {
    const panel = document.createElement('div');
    panel.id = 'zd-helper-panel';
    panel.className = 'hover-mode';
    panel.innerHTML = `
      <div class="header">
        <span id="timer-display" style="font-weight:bold; color:blue; min-width:35px;">00:00</span>
        <span id="info-header">연동 대기 중...</span>
        <div>
          <button id="home-btn" title="처음으로">🏠</button>
          <button id="pin-btn" title="고정">📌</button>
          <button id="stealth-btn" title="숨김">👻</button>
        </div>
      </div>
      <div id="eoc-detail-view" class="tab-view stealth"></div>
      <div id="calculator-view" class="tab-view stealth">
        <div style="padding: 8px; font-size: 10px;">
          <h4 style="margin-bottom: 8px;">🧮 안분가 계산기</h4>
          <div style="background: #f5f5f5; padding: 6px; border-radius: 3px; margin-bottom: 8px; font-size: 9px; line-height: 1.5;">
            <strong>공식:</strong> (판매금액 - 할인금액) / 판매금액 × 입력값
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
        <label style="font-size:10px;">상담사 이름</label>
        <input id="set-name" type="text" style="width:100%; font-size:10px;">
        <label style="font-size:10px; margin-top:5px; display:block;">퀵 버튼 (JSON 배열)</label>
        <div style="font-size:8px; color:#666; margin-bottom:2px;">
          예시: [{"label":"인사","text":"안녕하세요 {{상담사명}}입니다"},{"label":"끝인사","text":"좋은 하루 되세요!"}]
        </div>
        <textarea id="quick-buttons" style="width:100%; height:60px; font-size:9px; font-family:monospace;"></textarea>
        <button id="save-settings" style="width:100%; margin-top:3px; background:#32a1ce; color:white; font-size:10px;">저장</button>
      </div>
      <div id="btn-container"></div>
      <div id="anbunga-container"></div>
      <div id="quick-btn-container"></div>
      <div class="footer">
        <button id="toggle-detail">EOC 정보</button>
        <button id="toggle-calculator">🧮</button>
        <button id="toggle-settings">⚙️ 설정</button>
      </div>
      <div id="resize-handle"></div>
    `;
    document.body.appendChild(panel);

    const resizeHandle = document.getElementById('resize-handle');
    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true; startX = e.clientX; startY = e.clientY;
      startWidth = parseInt(getComputedStyle(panel).width, 10);
      startHeight = parseInt(getComputedStyle(panel).height, 10);
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const width = startWidth - (e.clientX - startX);
      const height = startHeight + (e.clientY - startY);
      panel.style.width = Math.max(200, Math.min(800, width)) + 'px';
      panel.style.height = Math.max(200, Math.min(window.innerHeight - 100, height)) + 'px';
    });

    document.addEventListener('mouseup', () => { isResizing = false; });

    window.tagEngine = function(text, data, settings) {
      let result = text || "";
      result = result.replace(/{{상담사명}}/g, settings.name || "상담사");
      
      if (data.eoc원문) {
        Object.entries(data.eoc원문).forEach(([key, val]) => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          result = result.replace(regex, typeof val === 'object' ? JSON.stringify(val) : val);
        });
      }
      
      Object.entries(data).forEach(([key, val]) => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        result = result.replace(regex, typeof val === 'object' ? JSON.stringify(val) : val);
      });
      return result;
    };

    window.refreshUI = function() {
      const tid = getTid();
      if (!tid) return;
      if (!ticketStore[tid]) {
        ticketStore[tid] = { scenario: null, tree: [], eoc: {} };
      }
      const data = ticketStore[tid];

      if (data.eoc["고유 주문 ID"] || (data.eoc.eoc원문 && data.eoc.eoc원문.고유주문번호)) {
        const fId = data.eoc["고유 주문 ID"] || data.eoc.eoc원문.고유주문번호;
        const shortId = data.eoc["축약형 주문 ID"] || data.eoc.eoc원문.축약형주문번호 || "";
        const storeName = data.eoc["이름"] || data.eoc.eoc원문.스토어명 || "";
        document.getElementById('info-header').innerText = `*${fId.slice(-4)} | ${shortId} | ${storeName}`;
      }

      const eocView = document.getElementById('eoc-detail-view');
      
      if (!data.eoc || !data.eoc.eoc원문) {
        eocView.innerHTML = '<div style="padding:4px; font-size:9px;">EOC 데이터 없음</div>';
      } else {
        const o = data.eoc.eoc원문;
        // 메뉴 HTML 생성
        let menuHtml = '';
        if (data.eoc["_주문메뉴_목록"] && Array.isArray(data.eoc["_주문메뉴_목록"])) {
          menuHtml = data.eoc["_주문메뉴_목록"].map(menu => {
            return `<div class="copyable-row" onclick="navigator.clipboard.writeText('${menu.details.replace(/'/g, "\\'")} (${menu.price})')">${menu.details} (${menu.price})</div>`;
          }).join('');
        }

        eocView.innerHTML = `
          <div style="padding:2px; font-size:9px;">
            <button id="toggle-raw-eoc" style="width:100%; padding:2px; font-size:8px; margin-bottom:2px; background:#f0f0f0; border:1px solid #ccc; cursor:pointer;">📋 EOC 원문 보기 ▼</button>
            <div id="raw-eoc-data" style="display:none; max-height:200px; overflow-y:auto; background:#f9f9f9; border:1px solid #ddd; padding:2px; margin-bottom:4px;">
              <table style="width:100%; font-size:8px; border-collapse:collapse;">
                ${Object.entries(o).map(([k,v])=>`
                  <tr style="border-bottom:1px solid #eee;">
                    <td style="padding:1px 2px; font-weight:bold; width:40%; word-break:break-word;">${k}</td>
                    <td style="padding:1px 2px; word-break:break-word;">${typeof v === 'object' ? JSON.stringify(v) : v}</td>
                  </tr>
                `).join('')}
              </table>
            </div>
            
            <div style="border:1px solid #ddd; padding:0;">
              <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.배달유형}')"><strong>주문유형</strong> | ${o.배달유형}</div>
              <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.고유주문번호}')"><strong>고유번호</strong> | ${o.고유주문번호}</div>
              <div class="copyable-row" onclick="navigator.clipboard.writeText('${(o.스토어명||"").replace(/'/g, "\\'")}')"><strong>매장명</strong> | ${o.스토어명}</div>
              <div class="copyable-row" onclick="navigator.clipboard.writeText('${(o.고객전화||"").replace(/-/g, "")}')"><strong>전화번호</strong> | ${(o.고객전화||"").replace(/-/g, "")}</div>
              <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.결제시각}')"><strong>결제시각</strong> | ${o.결제시각}</div>
              
              <div style="border-top:1px solid #ddd; margin-top:2px; padding-top:2px;">
                <div style="font-weight:bold; margin-bottom:2px;">주문 메뉴</div>
                ${menuHtml || `<div style="white-space:pre-wrap;">${o.주문메뉴}</div>`}
              </div>
              
              <div style="border-top:1px solid #ddd; margin-top:2px; padding-top:2px;">
                <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.판매가격}')"><strong>판매가격</strong> | ₩${(o.판매가격||0).toLocaleString()}</div>
                <div class="copyable-row" onclick="navigator.clipboard.writeText('${o.할인금액}')"><strong>상품할인</strong> | ₩${(o.할인금액||0).toLocaleString()}</div>
              </div>
            </div>
          </div>
        `;
        
        document.getElementById('toggle-raw-eoc').onclick = function() {
          const rawData = document.getElementById('raw-eoc-data');
          if (rawData.style.display === 'none') {
            rawData.style.display = 'block';
            this.textContent = '📋 EOC 원문 숨기기 ▲';
          } else {
            rawData.style.display = 'none';
            this.textContent = '📋 EOC 원문 보기 ▼';
          }
        };
      }

      const btnBox = document.getElementById('btn-container');
      btnBox.innerHTML = '';

      if (!data.scenario) {
        Object.keys(utteranceData).forEach(cat => {
          const btn = document.createElement('button');
          btn.className = 'action-btn btn-choice';
          btn.innerText = cat;
          btn.onclick = () => { data.scenario = cat; data.tree = []; refreshUI(); };
          btnBox.appendChild(btn);
        });
        return;
      }

      function renderTree(tree, depth = 0) {
        tree.forEach((node, idx) => {
          const btn = document.createElement('button');
          btn.className = `action-btn btn-${node.type}`;
          btn.innerText = node.label;
          if (node.text) btn.title = tagEngine(node.text, data.eoc, userSettings);
          btn.onclick = () => { tree.splice(idx + 1); refreshUI(); };
          btnBox.appendChild(btn);
          const marker = document.createElement('div'); marker.className = 'branch-marker'; btnBox.appendChild(marker);
          if (node.children && node.children.length > 0) renderTree(node.children, depth + 1);
        });
      }

      renderTree(data.tree);

      const currentStep = data.tree.length === 0 ? 'start' : data.tree[data.tree.length - 1].next;
      const options = utteranceData[data.scenario][currentStep] || [];

      if (options.length > 0) {
        const marker = document.createElement('div'); marker.className = 'branch-marker'; btnBox.appendChild(marker);
      }

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = `action-btn btn-${opt.type}`;
        btn.innerText = opt.label;
        if (opt.text) btn.title = tagEngine(opt.text, data.eoc, userSettings);
        btn.onclick = () => {
          data.tree.push({ ...opt, children: [] });
          if (opt.type === 'copy' && opt.text) {
            const finalMsg = tagEngine(opt.text, data.eoc, userSettings);
            navigator.clipboard.writeText(finalMsg);
          }
          refreshUI();
        };
        btnBox.appendChild(btn);
      });

      renderQuickButtons();
      renderAnbunga();
    };

    window.renderQuickButtons = function() {
      const quickBox = document.getElementById('quick-btn-container');
      if (!quickBox) return;
      quickBox.innerHTML = '';
      const quickBtns = userSettings.quickButtons || [];
      if (quickBtns.length === 0) {
        const hint = document.createElement('div');
        hint.style.fontSize = '9px'; hint.style.color = '#888'; hint.style.padding = '2px 4px';
        hint.innerText = '⚙️ 설정에서 퀵 버튼을 추가하세요';
        quickBox.appendChild(hint);
        return;
      }
      quickBtns.forEach(qb => {
        const btn = document.createElement('button');
        btn.className = 'action-btn btn-quick';
        btn.innerText = qb.label;
        btn.onclick = () => {
          const tid = getTid();
          const data = ticketStore[tid] || { eoc: {} };
          const finalMsg = tagEngine(qb.text, data.eoc, userSettings);
          navigator.clipboard.writeText(finalMsg);
        };
        quickBox.appendChild(btn);
      });
    };

    window.renderAnbunga = function() {
      const anbungaBox = document.getElementById('anbunga-container');
      if (!anbungaBox) return;
      const tid = getTid();
      const data = ticketStore[tid];
      if (!data || !data.eoc || !data.eoc["_안분가"]) {
        anbungaBox.innerHTML = '';
        return;
      }
      anbungaBox.innerHTML = `
        <div style="padding: 4px; background: #f0f0f0; border-top: 1px solid #ccc; font-size: 10px;">
          <strong>안분가:</strong> ${data.eoc["_안분가"]} 
          <span style="color: #666; margin-left: 4px;">
            (판매 ${data.eoc["_판매금액_숫자"]?.toLocaleString()} - 할인 ${data.eoc["_상품할인_숫자"]?.toLocaleString()})
          </span>
        </div>
      `;
    };

    chrome.storage.local.get("userSettings", r => { 
      if(r.userSettings) { 
        userSettings = r.userSettings; 
        document.getElementById('set-name').value = userSettings.name || ""; 
        document.getElementById('quick-buttons').value = JSON.stringify(userSettings.quickButtons || [], null, 2);
      } else {
        document.getElementById('quick-buttons').value = '[]';
      }
      renderQuickButtons();
    });

    document.getElementById('home-btn').onclick = () => {
      const tid = getTid();
      if (tid && ticketStore[tid]) {
        ticketStore[tid].scenario = null; ticketStore[tid].tree = []; refreshUI();
      }
    };

    document.getElementById('pin-btn').onclick = function() {
      if (panel.classList.contains('pinned')) {
        panel.classList.remove('pinned'); panel.classList.add('hover-mode'); this.style.background = 'transparent';
      } else {
        panel.classList.add('pinned'); panel.classList.remove('hover-mode'); this.style.background = '#ffc107';
      }
    };

    document.getElementById('stealth-btn').onclick = () => panel.classList.toggle('stealth');
    
    const header = panel.querySelector('.header');
    let isDragging = false;
    let dragStartX, dragStartY, panelStartX, panelStartY;
    
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
      const rect = panel.getBoundingClientRect(); panelStartX = rect.left; panelStartY = rect.top;
      header.style.cursor = 'grabbing'; e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const newLeft = panelStartX + (e.clientX - dragStartX);
      const newTop = panelStartY + (e.clientY - dragStartY);
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      panel.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
      panel.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
      panel.style.right = 'auto';
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) { isDragging = false; header.style.cursor = 'move'; }
    });
    header.style.cursor = 'move';

    document.getElementById('toggle-detail').onclick = () => { 
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth'); 
      document.getElementById('eoc-detail-view').classList.toggle('stealth'); 
    };

    document.getElementById('toggle-calculator').onclick = () => {
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('settings-view').classList.add('stealth');
      const calcView = document.getElementById('calculator-view');
      calcView.classList.toggle('stealth');
    };

    document.getElementById('toggle-settings').onclick = () => { 
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth'); 
      document.getElementById('settings-view').classList.toggle('stealth'); 
    };

    document.getElementById('calc-btn').onclick = () => {
      const tid = getTid();
      const data = ticketStore[tid];
      if (!data || !data.eoc || !data.eoc.eoc원문) {
        alert('EOC 데이터가 없습니다'); return;
      }
      const 판매금액 = data.eoc.eoc원문.판매금액 || 0;
      const 할인금액 = data.eoc.eoc원문.할인금액 || 0;
      const inputValue = parseFloat(document.getElementById('calc-input').value);
      if (isNaN(inputValue) || inputValue <= 0) { alert('올바른 숫자를 입력해주세요'); return; }
      if (판매금액 === 0) { alert('판매금액 정보가 없습니다'); return; }
      const ratio = (판매금액 - 할인금액) / 판매금액;
      const result = Math.round(ratio * inputValue);
      data.eoc.eoc원문.안분가 = `${result}원`;
      const resultDiv = document.getElementById('calc-result');
      resultDiv.textContent = `${result.toLocaleString()}원`;
      resultDiv.style.display = 'block';
      navigator.clipboard.writeText(result.toString());
    };

    document.getElementById('save-settings').onclick = () => { 
      userSettings.name = document.getElementById('set-name').value;
      try {
        userSettings.quickButtons = JSON.parse(document.getElementById('quick-buttons').value);
        chrome.storage.local.set({userSettings}); 
        alert("저장됨"); renderQuickButtons(); refreshUI();
      } catch (e) {
        alert("퀵 버튼 JSON 형식 오류:\n" + e.message);
      }
    };

    chrome.storage.onChanged.addListener(c => { 
      if(c.transfer_buffer) { 
        const tid = getTid();
        if(tid && ticketStore[tid]) { 
          ticketStore[tid].eoc = c.transfer_buffer.newValue; refreshUI(); 
        } 
      } 
    });

    setInterval(() => { 
      if (location.pathname !== lastPath) { lastPath = location.pathname; refreshUI(); } 
    }, 1000);

    refreshUI();
  }
}

function getTid() { 
  return location.pathname.match(/tickets\/(\d+)/)?.[1] || 'test-env'; 
}
