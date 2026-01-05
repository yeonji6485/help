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

/**
 * 카드 헤더로 특정 섹션 찾기
 */
function findCardByHeader(doc, headerText) {
  const cards = doc.querySelectorAll('.order-detail-card');
  for (const card of cards) {
    const header = card.querySelector('.el-card__header .clearfix span');
    if (header && header.textContent.trim() === headerText) {
      return card;
    }
  }
  return null;
}

/**
 * 안전하게 텍스트 추출
 */
function safeText(element, selector) {
  const el = element ? element.querySelector(selector) : null;
  return el ? el.textContent.trim() : '';
}

/**
 * 테이블 행을 key-value로 파싱
 */
function parseTableRows(card, selector = '.order-detail-table tr') {
  const result = {};
  if (!card) return result;
  
  const rows = card.querySelectorAll(selector);
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2) {
      const key = cells[0].textContent.trim();
      const value = cells[1].textContent.trim().split('\n')[0]; // 첫 줄만
      if (key && value) {
        result[key] = value;
      }
    }
  });
  
  return result;
}

/**
 * EOC 페이지 전체 파싱
 */
function parseEOCPage(doc) {
  const tags = {};
  
  // 1. 주문정보 카드
  const orderInfoCard = findCardByHeader(doc, '주문정보');
  if (orderInfoCard) {
    Object.assign(tags, parseTableRows(orderInfoCard));
  }
  
  // 2. 주문 메뉴 카드
  const orderMenuCard = findCardByHeader(doc, '주문 메뉴');
  if (orderMenuCard) {
    const menuRows = orderMenuCard.querySelectorAll('.el-table__body tbody tr');
    const menuItems = [];
    menuRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        menuItems.push({
          menuId: cells[0].textContent.trim(),
          price: cells[1].textContent.trim(),
          details: cells[2].textContent.trim()
        });
      }
    });
    if (menuItems.length > 0) {
      tags["_주문메뉴_목록"] = menuItems;
    }
  }
  
  // 3. 결제 카드
  const paymentCard = findCardByHeader(doc, '결제');
  if (paymentCard) {
    Object.assign(tags, parseTableRows(paymentCard));
    
    // 판매금액 추출 (결제 금액 섹션의 "판매가격:")
    const rows = paymentCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const key = cells[0].textContent.trim();
        if (key === "결제 금액") {
          const listItems = Array.from(cells[1].querySelectorAll('li'));
          listItems.forEach(li => {
            const text = li.textContent.trim();
            if (text.startsWith("판매가격:")) {
              const match = text.match(/₩([\d,]+)/);
              if (match) {
                tags["판매금액"] = parseInt(match[1].replace(/,/g, ''));
              }
            }
          });
        }
      }
    });
    
    // 쿠폰 정보 추출 - "쿠폰" 헤더 바로 아래의 테이블만
    let totalDiscount = 0;
    const couponHeader = Array.from(paymentCard.querySelectorAll('h4')).find(h => 
      h.textContent.includes('쿠폰')
    );
    
    if (couponHeader) {
      // 헤더 다음에 나오는 el-table을 찾기
      let nextEl = couponHeader.nextElementSibling;
      while (nextEl && !nextEl.classList.contains('el-table')) {
        nextEl = nextEl.nextElementSibling;
      }
      
      if (nextEl && nextEl.classList.contains('el-table')) {
        const couponRows = nextEl.querySelectorAll('.el-table__body tbody tr');
        couponRows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3) {
            const typeText = cells[1].textContent.trim();
            if (typeText === '상품 할인' || typeText === '디쉬 할인') {
              const amountText = cells[2].textContent.trim();
              const match = amountText.match(/₩([\d,]+)/);
              if (match) {
                totalDiscount += parseInt(match[1].replace(/,/g, ''));
              }
            }
          }
        });
      }
    }
    tags["상품할인"] = totalDiscount;
  }
  
  // 4. 배달지 카드
  const deliveryCard = findCardByHeader(doc, '배달지');
  if (deliveryCard) {
    Object.assign(tags, parseTableRows(deliveryCard));
    
    // 통합주소 생성 (도로명주소, 지명, 상세주소 순)
    const addressParts = [
      tags["도로명 주소"],
      tags["지명"],
      tags["상세 주소"]
    ].filter(Boolean);
    tags["통합주소"] = addressParts.join(', ');
  }
  
  // 5. 배달 작업 카드
  const deliveryTaskCard = findCardByHeader(doc, '배달 작업');
  if (deliveryTaskCard) {
    Object.assign(tags, parseTableRows(deliveryTaskCard));
  }
  
  // 6. 스토어 카드
  const storeCard = findCardByHeader(doc, '스토어');
  if (storeCard) {
    Object.assign(tags, parseTableRows(storeCard));
  }
  
  // 7. 쿠리어 카드
  const courierCard = findCardByHeader(doc, '쿠리어');
  if (courierCard) {
    Object.assign(tags, parseTableRows(courierCard));
  }
  
  // 8. 이슈 내용 카드
  const issueCard = findCardByHeader(doc, '이슈 내용');
  if (issueCard) {
    Object.assign(tags, parseTableRows(issueCard));
  }
  
  // 9. 보상내역 카드
  const compensationCard = findCardByHeader(doc, '보상내역');
  if (compensationCard) {
    const compRows = compensationCard.querySelectorAll('.el-table__body tbody tr');
    const compensations = [];
    compRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 5) {
        compensations.push({
          reason: cells[0].textContent.trim(),
          amount: cells[1].textContent.trim(),
          processor: cells[2].textContent.trim(),
          processedAt: cells[3].textContent.trim(),
          status: cells[4].textContent.trim()
        });
      }
    });
    if (compensations.length > 0) {
      tags["_보상내역"] = compensations;
    }
  }
  
  // 10. 이력 카드 - 배달완료 시각 추출
  const historyCard = findCardByHeader(doc, '이력');
  if (historyCard) {
    const historyRows = historyCard.querySelectorAll('.el-table__body tbody tr');
    historyRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 6) {
        const actionText = cells[2].textContent.trim(); // "조치" 열
        if (actionText === '배달 완료') {
          const createdText = cells[5].textContent.trim(); // "생성(ID)" 열
          const timeMatch = createdText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
          if (timeMatch) {
            const [, , , , hour, minute] = timeMatch;
            tags["배달완료시각"] = `${hour}시 ${minute}분`;
            tags["_배달완료_시"] = hour;
            tags["_배달완료_분"] = minute;
          }
        }
      }
    });
  }
  
  // 11. ETA1 시각 추출 및 포맷팅
  const eta1Raw = tags["ETA 1"] || tags["ETA1 (배정지연)"] || "";
  const etaTime = eta1Raw.replace(/최초시간\s*/g, "").trim();
  tags["_ETA1_시각"] = etaTime;
  
  if (etaTime && etaTime.includes(':')) {
    const [hour, minute] = etaTime.split(':');
    tags["ETA1_시각"] = `${hour}시 ${minute}분`;
    tags["_ETA1_시"] = parseInt(hour);
    tags["_ETA1_분"] = parseInt(minute);
  }
  
  // 12. 배달시간 계산 (ETA1 - 배달완료 시각, 분 단위)
  if (tags["_ETA1_시"] && tags["_배달완료_시"]) {
    const eta1Minutes = tags["_ETA1_시"] * 60 + tags["_ETA1_분"];
    const deliveryMinutes = parseInt(tags["_배달완료_시"]) * 60 + parseInt(tags["_배달완료_분"]);
    const diffMinutes = deliveryMinutes - eta1Minutes;
    tags["배달시간차이"] = diffMinutes > 0 ? `+${diffMinutes}분` : `${diffMinutes}분`;
  }
  
  tags["_ETA1_경과여부"] = isTimePassed(etaTime) ? "경과" : "미경과";
  
  // 13. 안분가 계산
  const salesPrice = tags["판매금액"] || 0;
  const productDiscount = tags["상품할인"] || 0;
  
  if (salesPrice > 0) {
    const ratio = ((salesPrice - productDiscount) / salesPrice * 100).toFixed(2);
    tags["_안분가"] = `${ratio}%`;
    tags["_판매금액_숫자"] = salesPrice;
    tags["_상품할인_숫자"] = productDiscount;
  }
  
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
// 테스트용: 모든 페이지에서 로드
let ticketStore = {};
let utteranceData = {};
let userSettings = { name: "" };
let lastPath = location.pathname;

// JSON 외부 데이터 로드
fetch(chrome.runtime.getURL('data_generated.json'))
  .then(r => r.json())
  .then(data => {
    console.log('Data loaded:', data);
    utteranceData = data.scenarios;
    console.log('Scenarios:', Object.keys(utteranceData));
    // 설정은 저장된 값 우선, 없으면 빈 기본값
    if (!userSettings.name) userSettings.name = "";
    if (!userSettings.quickButtons) userSettings.quickButtons = [];
    initUI(); 
  })
  .catch(err => {
    console.error('Failed to load data:', err);
    utteranceData = {};
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
      <div id="sms-view" class="tab-view stealth"></div>
      <div id="calculator-view" class="tab-view stealth">
        <div style="padding: 8px; font-size: 10px;">
          <h4 style="margin-bottom: 8px;">🧮 안분 계산기</h4>
          <div style="margin-bottom: 6px;">
            <label style="display: block; margin-bottom: 2px;">판매금액:</label>
            <input id="calc-sales" type="text" readonly style="width: 100%; padding: 4px; background: #f0f0f0; border: 1px solid #ccc; font-size: 10px;">
          </div>
          <div style="margin-bottom: 6px;">
            <label style="display: block; margin-bottom: 2px;">상품할인:</label>
            <input id="calc-discount" type="text" readonly style="width: 100%; padding: 4px; background: #f0f0f0; border: 1px solid #ccc; font-size: 10px;">
          </div>
          <div style="margin-bottom: 6px;">
            <label style="display: block; margin-bottom: 2px;">안분율:</label>
            <input id="calc-ratio" type="text" readonly style="width: 100%; padding: 4px; background: #f0f0f0; border: 1px solid #ccc; font-size: 10px;">
          </div>
          <div style="margin-bottom: 6px;">
            <label style="display: block; margin-bottom: 2px;">곱할 값 입력:</label>
            <input id="calc-input" type="number" placeholder="숫자 입력" style="width: 100%; padding: 4px; border: 1px solid #ccc; font-size: 10px;">
          </div>
          <button id="calc-btn" style="width: 100%; padding: 6px; background: #32a1ce; color: white; border: none; border-radius: 2px; cursor: pointer; font-size: 10px;">계산</button>
          <div id="calc-result" style="margin-top: 8px; padding: 6px; background: #e8f5e9; border: 1px solid #4caf50; border-radius: 2px; font-weight: bold; text-align: center; display: none;"></div>
        </div>
      </div>
      <div id="settings-view" class="tab-view stealth"></div>
      <div id="btn-container"></div>
      <div id="quick-btn-container"></div>
      <div class="footer">
        <button id="toggle-detail">📋 EOC</button>
        <button id="toggle-sms">💬 SMS</button>
        <button id="toggle-calculator">🧮 계산</button>
        <button id="toggle-settings">⚙️ 설정</button>
      </div>
      <div id="resize-handle"></div>
    `;
    document.body.appendChild(panel);

    // 크기 조절 핸들 로직
    const resizeHandle = document.getElementById('resize-handle');
    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = panel.offsetWidth;
      startHeight = panel.offsetHeight;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      
      const deltaX = startX - e.clientX;
      const deltaY = e.clientY - startY;
      
      const newWidth = Math.max(150, startWidth + deltaX);
      const newHeight = Math.max(200, startHeight + deltaY);
      
      panel.style.width = newWidth + 'px';
      panel.style.height = newHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
      }
    });

    // 타이머 시작 (새 티켓 열릴 때 리셋)
    let timerInterval = null;
    let timerSeconds = 0;

    function startTimer() {
      timerSeconds = 0;
      clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        timerSeconds++;
        const minutes = Math.floor(timerSeconds / 60);
        const seconds = timerSeconds % 60;
        document.getElementById('timer-display').textContent = 
          `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }, 1000);
    }

    function stopTimer() {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    // UI 갱신 함수
    function refreshUI() {
      const tid = getTid();
      console.log('refreshUI called, tid:', tid);
      console.log('utteranceData:', utteranceData);
      
      if (!ticketStore[tid]) { 
        ticketStore[tid] = { scenario: null, tree: [], eoc: null }; 
        startTimer(); // 새 티켓이면 타이머 시작
      }
      
      const ticket = ticketStore[tid];
      const nodeId = ticket.tree[ticket.tree.length - 1] || 'start';
      
      console.log('ticket:', ticket);
      console.log('scenario:', ticket.scenario, 'nodeId:', nodeId);
      
      // 헤더 정보 업데이트
      let headerText = '연동 대기 중...';
      if (ticket.eoc) {
        headerText = ticket.eoc["축약형 주문 ID"] || ticket.eoc["고유 주문 ID"] || "EOC 연동됨";
      }
      document.getElementById('info-header').textContent = headerText;
      
      // EOC 상세 정보 탭
      renderEOCDetail();
      
      // 버튼 컨테이너 갱신
      const container = document.getElementById('btn-container');
      container.innerHTML = '';
      
      console.log('Rendering buttons...');
      
      if (!ticket.scenario) {
        // 시나리오 선택
        console.log('Rendering scenario selection buttons');
        for (const key in utteranceData) {
          console.log('Creating button for:', key);
          const btn = document.createElement('button');
          btn.className = 'action-btn btn-choice';
          btn.textContent = key;
          btn.onclick = () => { 
            ticket.scenario = key; 
            ticket.tree = ['start']; 
            refreshUI(); 
          };
          container.appendChild(btn);
        }
      } else {
        // 현재 시나리오의 노드 버튼들
        const scenario = utteranceData[ticket.scenario];
        if (!scenario || !scenario[nodeId]) {
          ticket.scenario = null;
          ticket.tree = [];
          refreshUI();
          return;
        }
        
        scenario[nodeId].forEach(action => {
          const btn = document.createElement('button');
          btn.className = 'action-btn';
          
          if (action.type === 'copy') {
            btn.className += ' btn-copy';
            btn.textContent = action.label;
            btn.onclick = () => {
              copyToClipboard(replaceTags(action.text, ticket.eoc));
              if (action.next) {
                ticket.tree.push(action.next);
                refreshUI();
              }
            };
          } else if (action.type === 'choice') {
            btn.className += ' btn-choice';
            btn.textContent = action.label;
            btn.onclick = () => {
              if (action.next) {
                ticket.tree.push(action.next);
                refreshUI();
              }
            };
          } else if (action.type === 'exception') {
            btn.className += ' btn-exception';
            btn.textContent = action.label;
            btn.onclick = () => {
              copyToClipboard(replaceTags(action.text, ticket.eoc));
              if (action.next) {
                ticket.tree.push(action.next);
                refreshUI();
              }
            };
          }
          
          container.appendChild(btn);
        });
        
        // 브랜치 마커 (되돌아가기)
        if (ticket.tree.length > 1) {
          const marker = document.createElement('div');
          marker.className = 'branch-marker';
          marker.title = '이전 단계로';
          marker.style.cursor = 'pointer';
          marker.onclick = () => {
            ticket.tree.pop();
            refreshUI();
          };
          container.appendChild(marker);
        }
      }
    }

    // 태그 치환
    function replaceTags(text, eoc) {
      if (!eoc) return text;
      let result = text;
      
      // 상담사명 치환
      result = result.replace(/\{\{상담사명\}\}/g, userSettings.name || '상담사');
      
      // EOC 태그 치환
      for (const key in eoc) {
        const placeholder = `{{${key}}}`;
        if (result.includes(placeholder)) {
          result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), eoc[key]);
        }
      }
      
      return result;
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        // 성공 피드백 (선택사항)
      });
    }

    // 퀵 버튼 렌더링
    function renderQuickButtons() {
      const container = document.getElementById('quick-btn-container');
      container.innerHTML = '';
      
      const quickButtons = userSettings.quickButtons || [];
      quickButtons.forEach(btn => {
        const button = document.createElement('button');
        button.className = 'action-btn btn-quick';
        button.textContent = btn.label;
        button.onclick = () => {
          const tid = getTid();
          const ticket = ticketStore[tid];
          copyToClipboard(replaceTags(btn.text, ticket ? ticket.eoc : null));
        };
        container.appendChild(button);
      });
    }

    // EOC 상세 정보 렌더링
    function renderEOCDetail() {
      const tid = getTid();
      const data = ticketStore[tid];
      const detailView = document.getElementById('eoc-detail-view');
      
      if (!data || !data.eoc) {
        detailView.innerHTML = '<div style="padding: 8px; font-size: 10px;">EOC 데이터 없음</div>';
        return;
      }
      
      let html = '<div style="padding: 4px; font-size: 9px; overflow-y: auto; height: 100%;">';
      html += '<h4 style="margin-bottom: 4px; font-size: 11px;">📋 EOC 정보</h4>';
      
      // 주문 유형 (세이브 배달이면 "무료배달", 아니면 "한집배달")
      const orderType = (data.eoc["주문 유형"] || "").includes("세이브") ? "무료배달" : "한집배달";
      
      // 주요 정보만 표시
      const displayItems = [
        { label: "주문유형", value: orderType },
        { label: "고유번호", value: data.eoc["고유 주문 ID"] },
        { label: "매장명", value: data.eoc["이름"] },
        { label: "전화번호", value: data.eoc["전화번호"]?.replace(/-/g, "") },
        { label: "축약번호", value: data.eoc["축약형 주문 ID"] },
        { label: "판매가격", value: data.eoc["판매금액"] },
        { label: "상품할인", value: data.eoc["상품할인"] },
        { label: "파트너유형", value: data.eoc["배달 유형"] || data.eoc["쿠리어 타입"] },
        { label: "파트너ID", value: data.eoc["쿠리어 ID"] },
        { label: "파트너전화", value: data.eoc["전화번호"]?.replace(/-/g, "") }
      ];
      
      displayItems.forEach(item => {
        if (item.value) {
          let displayValue = item.value;
          // 금액은 숫자만 추출
          if (item.label.includes("가격") || item.label.includes("할인")) {
            const numMatch = String(item.value).match(/\d+/g);
            displayValue = numMatch ? numMatch.join("") : item.value;
          }
          
          html += `<div class="copyable-row" onclick="navigator.clipboard.writeText('${String(displayValue).replace(/'/g, "\\'")}')">`;
          html += `<strong>${item.label}:</strong> ${displayValue}`;
          html += `</div>`;
        }
      });
      
      html += '</div>';
      detailView.innerHTML = html;
    };

    // SMS 탭 렌더링
    function renderSMS() {
      const smsView = document.getElementById('sms-view');
      if (!smsView) return;
      
      const smsTemplates = userSettings.smsTemplates || getDefaultSMSTemplates();
      
      let html = '<div style="padding: 2px; font-size: 9px; overflow-y: auto; height: 100%;">';
      html += '<h4 style="margin: 2px 0; font-size: 11px; text-align: center;">💬 SMS 발송</h4>';
      
      const groups = [
        { name: "고객", emoji: "👤" },
        { name: "배달파트너", emoji: "🛵" },
        { name: "스토어", emoji: "🏪" }
      ];
      
      groups.forEach(group => {
        html += `<div style="margin: 4px 0; border-top: 1px solid #ddd; padding-top: 2px;">`;
        html += `<div style="font-weight: bold; margin-bottom: 2px;">${group.emoji} ${group.name}</div>`;
        html += `<div style="display: flex; flex-wrap: wrap; gap: 2px;">`;
        
        const templates = smsTemplates[group.name] || [];
        templates.forEach((template, idx) => {
          html += `<button class="action-btn btn-sms" style="width: calc(50% - 1px); min-height: 20px; padding: 2px 4px; font-size: 9px;" onclick="copyToClipboard('${template.text.replace(/'/g, "\\'")}')">`;
          html += template.label;
          html += `</button>`;
        });
        
        html += `</div></div>`;
      });
      
      html += '</div>';
      smsView.innerHTML = html;
    }

    // 기본 SMS 템플릿
    function getDefaultSMSTemplates() {
      return {
        "고객": [
          { label: "배달지연", text: "고객님, 주문하신 음식이 배달 지연되고 있습니다. 죄송합니다." },
          { label: "조리지연", text: "고객님, 매장에서 조리가 지연되고 있습니다. 죄송합니다." },
          { label: "[내용작성]", text: "" },
          { label: "[내용작성]", text: "" }
        ],
        "배달파트너": [
          { label: "픽업요청", text: "픽업 부탁드립니다." },
          { label: "정정배달", text: "정정배달 요청합니다." },
          { label: "[내용작성]", text: "" },
          { label: "[내용작성]", text: "" }
        ],
        "스토어": [
          { label: "조리독촉", text: "조리 진행 부탁드립니다." },
          { label: "재조리", text: "재조리 요청합니다." },
          { label: "[내용작성]", text: "" },
          { label: "[내용작성]", text: "" }
        ]
      };
    }

    // 설정 탭 렌더링
    function renderSettings() {
      const settingsView = document.getElementById('settings-view');
      if (!settingsView) return;
      
      const smsTemplates = userSettings.smsTemplates || getDefaultSMSTemplates();
      
      function getGroupEmoji(group) {
        const emojis = { "고객": "👤", "배달파트너": "🛵", "스토어": "🏪" };
        return emojis[group] || "";
      }
      
      // 퀵버튼을 JSON으로 변환
      const quickButtonsJson = JSON.stringify(userSettings.quickButtons || [], null, 2);
      
      // SMS 템플릿을 그룹별 JSON으로 변환
      const smsJson = {};
      Object.keys(smsTemplates).forEach(group => {
        smsJson[group] = JSON.stringify(smsTemplates[group], null, 2);
      });
      
      settingsView.innerHTML = `
        <div style="padding: 4px; font-size: 10px; overflow-y: auto; height: 100%;">
          <label style="font-size:10px; display:block; margin-bottom:2px;">상담사 이름</label>
          <input id="input-name" type="text" value="${userSettings.name || ''}" placeholder="상담사" style="width:100%; font-size:10px; padding:4px; margin-bottom:8px; border:1px solid #ccc; border-radius:2px;">
          
          <hr style="margin:8px 0; border:none; border-top:1px solid #ddd;">
          
          <label style="font-size:10px; display:block; margin-bottom:2px;">퀵 버튼 (JSON 배열)</label>
          <textarea id="quick-buttons-json" placeholder='[{"label":"인사","text":"안녕하세요 {{상담사명}}입니다"},{"label":"끝인사","text":"좋은 하루 되세요!"}]' style="width:100%; height:60px; font-size:9px; font-family:monospace; padding:4px; border:1px solid #ccc; border-radius:2px; resize:vertical;">${quickButtonsJson}</textarea>
          <button id="btn-save-quick" style="width:100%; margin:4px 0; padding:4px; background:#32a1ce; color:white; border:none; border-radius:2px; font-size:9px; cursor:pointer;">퀵 버튼 저장</button>
          
          <hr style="margin:8px 0; border:none; border-top:1px solid #ddd;">
          
          <label style="font-size:10px; display:block; margin-bottom:4px;">SMS 설정</label>
          
          <div style="margin:4px 0;">
            <div style="font-weight:bold; font-size:10px; margin-bottom:2px;">👤 고객</div>
            <textarea id="sms-customer" placeholder='[{"label":"배달지연","text":"고객님, 주문하신 음식이..."},{"label":"조리지연","text":"고객님, 매장에서..."}]' style="width:100%; height:50px; font-size:9px; font-family:monospace; padding:4px; border:1px solid #ccc; border-radius:2px; resize:vertical;">${smsJson["고객"]}</textarea>
          </div>
          
          <div style="margin:4px 0;">
            <div style="font-weight:bold; font-size:10px; margin-bottom:2px;">🛵 배달파트너</div>
            <textarea id="sms-partner" placeholder='[{"label":"픽업요청","text":"픽업 부탁드립니다."},{"label":"정정배달","text":"정정배달 요청합니다."}]' style="width:100%; height:50px; font-size:9px; font-family:monospace; padding:4px; border:1px solid #ccc; border-radius:2px; resize:vertical;">${smsJson["배달파트너"]}</textarea>
          </div>
          
          <div style="margin:4px 0;">
            <div style="font-weight:bold; font-size:10px; margin-bottom:2px;">🏪 스토어</div>
            <textarea id="sms-store" placeholder='[{"label":"조리독촉","text":"조리 진행 부탁드립니다."},{"label":"재조리","text":"재조리 요청합니다."}]' style="width:100%; height:50px; font-size:9px; font-family:monospace; padding:4px; border:1px solid #ccc; border-radius:2px; resize:vertical;">${smsJson["스토어"]}</textarea>
          </div>
          
          <button id="btn-save-sms" style="width:100%; margin:4px 0; padding:4px; background:#32a1ce; color:white; border:none; border-radius:2px; font-size:9px; cursor:pointer;">SMS 설정 저장</button>
        </div>
      `;
      
      // 이름 저장
      document.getElementById('input-name').addEventListener('change', function() {
        userSettings.name = this.value;
        chrome.storage.local.set({userSettings});
        document.getElementById('info-header').textContent = this.value;
      });
      
      // 퀵버튼 저장
      document.getElementById('btn-save-quick').onclick = function() {
        try {
          const jsonText = document.getElementById('quick-buttons-json').value;
          const parsed = JSON.parse(jsonText);
          
          if (!Array.isArray(parsed)) {
            throw new Error('배열 형식이어야 합니다');
          }
          
          userSettings.quickButtons = parsed;
          chrome.storage.local.set({userSettings});
          renderQuickButtons();
          alert('퀵 버튼이 저장되었습니다.');
        } catch (e) {
          alert('JSON 형식 오류:\n' + e.message);
        }
      };
      
      // SMS 저장
      document.getElementById('btn-save-sms').onclick = function() {
        try {
          const customerJson = document.getElementById('sms-customer').value;
          const partnerJson = document.getElementById('sms-partner').value;
          const storeJson = document.getElementById('sms-store').value;
          
          const newTemplates = {
            "고객": JSON.parse(customerJson),
            "배달파트너": JSON.parse(partnerJson),
            "스토어": JSON.parse(storeJson)
          };
          
          // 유효성 검사
          Object.entries(newTemplates).forEach(([group, templates]) => {
            if (!Array.isArray(templates)) {
              throw new Error(`${group}: 배열 형식이어야 합니다`);
            }
            templates.forEach((template, idx) => {
              if (!template.label || !template.text) {
                throw new Error(`${group} ${idx+1}번째: label과 text가 필요합니다`);
              }
            });
          });
          
          userSettings.smsTemplates = newTemplates;
          chrome.storage.local.set({userSettings});
          renderSMS();
          alert('SMS 설정이 저장되었습니다.');
        } catch (e) {
          alert('JSON 형식 오류:\n' + e.message);
        }
      };
    }

    // 안분가 렌더링 함수
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

    // 설정 로드
    chrome.storage.local.get("userSettings", r => { 
      if(r.userSettings) { 
        userSettings = r.userSettings;
        // SMS 템플릿이 없으면 기본값 설정
        if (!userSettings.smsTemplates) {
          userSettings.smsTemplates = getDefaultSMSTemplates();
        }
      } else {
        // 초기값 설정
        userSettings = {
          name: "",
          quickButtons: [],
          smsTemplates: getDefaultSMSTemplates()
        };
      }
      renderQuickButtons();
      renderSMS();
    });

    // 버튼 이벤트 바인딩
    document.getElementById('home-btn').onclick = () => {
      const tid = getTid();
      if (tid && ticketStore[tid]) {
        ticketStore[tid].scenario = null;
        ticketStore[tid].tree = [];
        refreshUI();
      }
    };

    // 고정 버튼 (수정 - 제대로 토글되게)
    document.getElementById('pin-btn').onclick = function() {
      if (panel.classList.contains('pinned')) {
        panel.classList.remove('pinned');
        panel.classList.add('hover-mode');
        this.style.background = 'transparent';
      } else {
        panel.classList.add('pinned');
        panel.classList.remove('hover-mode');
        this.style.background = '#ffc107';
      }
    };

    document.getElementById('stealth-btn').onclick = () => panel.classList.toggle('stealth');
    
    // 드래그 이동 기능 추가
    const header = panel.querySelector('.header');
    let isDragging = false;
    let dragStartX, dragStartY, panelStartX, panelStartY;
    
    header.addEventListener('mousedown', (e) => {
      // 버튼 클릭은 드래그 시작하지 않음
      if (e.target.tagName === 'BUTTON') return;
      
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      
      const rect = panel.getBoundingClientRect();
      panelStartX = rect.left;
      panelStartY = rect.top;
      
      header.style.cursor = 'grabbing';
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      
      const newLeft = panelStartX + deltaX;
      const newTop = panelStartY + deltaY;
      
      // 화면 밖으로 나가지 않도록 제한
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      
      panel.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
      panel.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
      panel.style.right = 'auto'; // right 속성 제거
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        header.style.cursor = 'move';
      }
    });
    
    header.style.cursor = 'move';

    document.getElementById('toggle-detail').onclick = () => { 
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth'); 
      document.getElementById('sms-view').classList.add('stealth');
      document.getElementById('eoc-detail-view').classList.toggle('stealth'); 
    };

    document.getElementById('toggle-sms').onclick = () => {
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth');
      const smsView = document.getElementById('sms-view');
      smsView.classList.toggle('stealth');
      
      // SMS 탭 열릴 때 렌더링
      if (!smsView.classList.contains('stealth')) {
        renderSMS();
      }
    };

    document.getElementById('toggle-calculator').onclick = () => {
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('sms-view').classList.add('stealth');
      const calcView = document.getElementById('calculator-view');
      calcView.classList.toggle('stealth');
      
      // 계산기 열릴 때 현재 티켓 데이터로 초기화
      if (!calcView.classList.contains('stealth')) {
        const tid = getTid();
        const data = ticketStore[tid];
        if (data && data.eoc) {
          const sales = data.eoc["판매금액"] || 0;
          const discount = data.eoc["상품할인"] || 0;
          const ratio = sales > 0 ? (sales - discount) / sales : 0;
          
          document.getElementById('calc-sales').value = sales.toLocaleString();
          document.getElementById('calc-discount').value = discount.toLocaleString();
          document.getElementById('calc-ratio').value = (ratio * 100).toFixed(2) + '%';
        }
      }
    };

    document.getElementById('toggle-settings').onclick = () => { 
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth'); 
      document.getElementById('sms-view').classList.add('stealth');
      const settingsView = document.getElementById('settings-view');
      settingsView.classList.toggle('stealth');
      
      // 설정 탭 열릴 때 렌더링
      if (!settingsView.classList.contains('stealth')) {
        renderSettings();
      }
    };

    // 계산기 계산 버튼
    document.getElementById('calc-btn').onclick = () => {
      const tid = getTid();
      const data = ticketStore[tid];
      if (!data || !data.eoc) {
        alert('EOC 데이터가 없습니다');
        return;
      }
      
      const sales = data.eoc["판매금액"] || 0;
      const discount = data.eoc["상품할인"] || 0;
      const inputValue = parseFloat(document.getElementById('calc-input').value);
      
      if (isNaN(inputValue) || inputValue <= 0) {
        alert('올바른 숫자를 입력해주세요');
        return;
      }
      
      const ratio = (sales - discount) / sales;
      const result = Math.round(ratio * inputValue);
      
      const resultDiv = document.getElementById('calc-result');
      resultDiv.textContent = `결과: ${result.toLocaleString()}`;
      resultDiv.style.display = 'block';
      
      // 클립보드에 복사
      navigator.clipboard.writeText(result.toString());
    };

    // EOC 데이터 수신 감지
    chrome.storage.onChanged.addListener(c => { 
      if(c.transfer_buffer) { 
        const tid = getTid();
        if(tid && ticketStore[tid]) { 
          ticketStore[tid].eoc = c.transfer_buffer.newValue; 
          refreshUI(); 
        } 
      } 
    });

    // URL 변경 감지 (티켓 전환)
    setInterval(() => { 
      if (location.pathname !== lastPath) { 
        lastPath = location.pathname; 
        refreshUI(); 
      } 
    }, 1000);

    refreshUI();
  }

function getTid() { 
  return location.pathname.match(/tickets\/(\d+)/)?.[1] || 'test-env'; 
}