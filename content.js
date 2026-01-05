const isEOC = location.host.includes('coupang.net');
const isZD = location.host.includes('zendesk.com') || location.host.includes('google.com');

// ============================================================================
// [EOC] 데이터 수집 및 전송
// ============================================================================
if (isEOC) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-testid="zendesk_order_ticket_async"]');
    if (btn) {
      const tags = {};
      
      // 기본 필드 수집
      document.querySelectorAll('tr').forEach(tr => {
        if (tr.cells.length >= 2) {
          const key = tr.cells[0].innerText.trim();
          const cell = tr.cells[1];
          const val = cell.innerText.trim().split('\n')[0];
          tags[key] = val;
        }
      });
      
      // 통합주소 생성 (도로명주소, 지명, 상세주소 순)
      const addressParts = [
        tags["도로명 주소"],
        tags["지명"],
        tags["상세 주소"]
      ].filter(Boolean);
      tags["통합주소"] = addressParts.join(', ');
      
      // 판매금액 추출 (결제 금액 섹션의 "판매가격:")
      document.querySelectorAll('tr').forEach(tr => {
        if (tr.cells.length >= 2) {
          const key = tr.cells[0].innerText.trim();
          if (key === "결제 금액") {
            const cell = tr.cells[1];
            const listItems = Array.from(cell.querySelectorAll('li'));
            listItems.forEach(li => {
              const text = li.innerText.trim();
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
      
      // 상품 할인 + 디쉬 할인 합산 (쿠폰 테이블에서)
      let totalDiscount = 0;
      const couponTables = document.querySelectorAll('.el-table');
      couponTables.forEach(table => {
        const headerText = table.closest('.el-card__body')?.previousElementSibling?.textContent || '';
        if (headerText.includes('쿠폰')) {
          const rows = table.querySelectorAll('.el-table__body tr');
          rows.forEach(row => {
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
      });
      tags["상품할인"] = totalDiscount;
      
      // 배달완료 시각 추출 (이력 테이블에서)
      const historyTables = document.querySelectorAll('.el-table');
      historyTables.forEach(table => {
        const rows = table.querySelectorAll('.el-table__body tr');
        rows.forEach(row => {
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
      });
      
      // ETA1 시각 추출 및 포맷팅
      const eta1Raw = tags["ETA 1"] || tags["ETA1 (배정지연)"] || "";
      const etaTime = eta1Raw.replace(/최초시간\s*/g, "").trim();
      tags["_ETA1_시각"] = etaTime;
      
      if (etaTime && etaTime.includes(':')) {
        const [hour, minute] = etaTime.split(':');
        tags["ETA1_시각"] = `${hour}시 ${minute}분`;
        tags["_ETA1_시"] = parseInt(hour);
        tags["_ETA1_분"] = parseInt(minute);
      }
      
      // 배달시간 계산 (ETA1 - 배달완료 시각, 분 단위)
      if (tags["_ETA1_시"] && tags["_배달완료_시"]) {
        const eta1Minutes = tags["_ETA1_시"] * 60 + tags["_ETA1_분"];
        const deliveryMinutes = parseInt(tags["_배달완료_시"]) * 60 + parseInt(tags["_배달완료_분"]);
        const diffMinutes = deliveryMinutes - eta1Minutes;
        tags["배달시간차이"] = diffMinutes > 0 ? `+${diffMinutes}분` : `${diffMinutes}분`;
      }
      
      tags["_ETA1_경과여부"] = isTimePassed(etaTime) ? "경과" : "미경과";
      
      // 주문 메뉴 수집
      const menuList = [];
      const orderMenuCard = Array.from(document.querySelectorAll('.order-detail-card')).find(card => {
        const header = card.querySelector('.el-card__header .clearfix span');
        return header && header.textContent.trim() === '주문 메뉴';
      });
      if (orderMenuCard) {
        const menuRows = orderMenuCard.querySelectorAll('.el-table__body tbody tr');
        menuRows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3) {
            menuList.push(cells[2].textContent.trim());
          }
        });
      }
      tags["주문메뉴"] = menuList;
      
      // 안분가 계산
      const salesPrice = tags["판매금액"] || 0;
      const productDiscount = tags["상품할인"] || 0;
      
      if (salesPrice > 0) {
        const ratio = ((salesPrice - productDiscount) / salesPrice * 100).toFixed(2);
        tags["_안분가"] = `${ratio}%`;
        tags["_판매금액_숫자"] = salesPrice;
        tags["_상품할인_숫자"] = productDiscount;
      }

      chrome.storage.local.set({ "transfer_buffer": { ...tags, _ts: Date.now() } });
    }
  });
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
  let ticketStore = {};
  let utteranceData = {};
  let userSettings = { name: "" };
  let lastPath = location.pathname;

  // JSON 외부 데이터 로드
  fetch(chrome.runtime.getURL('data_generated.json'))
    .then(r => r.json())
    .then(data => { 
      utteranceData = data.scenarios; 
      // 설정은 저장된 값 우선, 없으면 빈 기본값
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
      <div id="eoc-info-view" class="tab-view stealth"></div>
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
      <div id="settings-view" class="tab-view stealth">
        <div style="padding:4px;overflow-y:auto;max-height:calc(45vh - 52px);">
          <label style="font-size:10px;">상담사 이름</label>
          <input id="set-name" type="text" style="width:100%; font-size:10px; margin-bottom:8px;" placeholder="상담사">
          
          <hr style="margin:8px 0;border:none;border-top:1px solid #ddd;">
          
          <label style="font-size:10px;">퀵 버튼 (JSON 배열)</label>
          <textarea id="quick-buttons" style="width:100%; height:60px; font-size:9px; font-family:monospace; margin-bottom:4px;" placeholder='[{"label":"인사","text":"안녕하세요 {{상담사명}}입니다"},{"label":"끝인사","text":"좋은 하루 되세요!"}]'></textarea>
          <button id="save-quick-settings" style="width:100%; margin-bottom:8px; background:#32a1ce; color:white; font-size:10px; padding:4px; border:none; border-radius:2px; cursor:pointer;">퀵 버튼 저장</button>
          
          <hr style="margin:8px 0;border:none;border-top:1px solid #ddd;">
          
          <label style="font-size:10px;">SMS 템플릿 - 고객</label>
          <textarea id="sms-customer" style="width:100%; height:50px; font-size:9px; font-family:monospace; margin-bottom:4px;" placeholder='[{"label":"배달지연","text":"고객님, 주문하신 음식이 배달 지연되고 있습니다. 죄송합니다."},{"label":"조리지연","text":"고객님, 매장에서 조리가 지연되고 있습니다. 죄송합니다."}]'></textarea>
          
          <label style="font-size:10px;">SMS 템플릿 - 배달파트너</label>
          <textarea id="sms-partner" style="width:100%; height:50px; font-size:9px; font-family:monospace; margin-bottom:4px;" placeholder='[{"label":"픽업요청","text":"픽업 부탁드립니다."},{"label":"정정배달","text":"정정배달 요청합니다."}]'></textarea>
          
          <label style="font-size:10px;">SMS 템플릿 - 스토어</label>
          <textarea id="sms-store" style="width:100%; height:50px; font-size:9px; font-family:monospace; margin-bottom:4px;" placeholder='[{"label":"조리독촉","text":"조리 진행 부탁드립니다."},{"label":"재조리","text":"재조리 요청합니다."}]'></textarea>
          
          <button id="save-sms-settings" style="width:100%; margin-top:4px; background:#32a1ce; color:white; font-size:10px; padding:4px; border:none; border-radius:2px; cursor:pointer;">SMS 설정 저장</button>
        </div>
      </div>
      <div id="btn-container"></div>
      <div id="anbunga-container"></div>
      <div id="quick-btn-container"></div>
      <div class="footer">
        <button id="toggle-detail">EOC 원문</button>
        <button id="toggle-eoc-info">EOC 정보</button>
        <button id="toggle-sms">SMS</button>
        <button id="toggle-calculator">🧮</button>
        <button id="toggle-settings">⚙️</button>
      </div>
      <div id="resize-handle"></div>
    `;
    document.body.appendChild(panel);

    // 크기 조절 기능
    const resizeHandle = document.getElementById('resize-handle');
    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
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

    document.addEventListener('mouseup', () => {
      isResizing = false;
    });

    // 태그 치환 엔진
    window.tagEngine = function(text, data, settings) {
      let result = text || "";
      result = result.replace(/{{상담사명}}/g, settings.name || "상담사");
      Object.entries(data).forEach(([key, val]) => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        result = result.replace(regex, val);
      });
      return result;
    };

    // UI 새로고침 함수
    window.refreshUI = function() {
      const tid = getTid();
      if (!tid) return;
      if (!ticketStore[tid]) {
        ticketStore[tid] = { 
          scenario: null, 
          tree: [],  // 선택 트리: [{step, choice, children: [...]}, ...]
          eoc: {} 
        };
      }
      const data = ticketStore[tid];

      // 헤더 박제 정보 업데이트
      if (data.eoc["고유 주문 ID"]) {
        const fId = data.eoc["고유 주문 ID"];
        const shortId = data.eoc["축약형 주문 ID"] || "";
        const storeName = data.eoc["이름"] || "";
        document.getElementById('info-header').innerText = `*${fId.slice(-4)} | ${shortId} | ${storeName}`;
      }

      // EOC 상세 정보 테이블 렌더링
      const eocView = document.getElementById('eoc-detail-view');
      eocView.innerHTML = `
        <div style="overflow-y:auto; max-height:calc(100% - 10px); padding:2px;">
          <table style="width:100%; font-size:9px; border-collapse:collapse;">
            ${Object.entries(data.eoc).map(([k,v])=>`
              <tr style="border-bottom:1px solid #eee;">
                <td style="padding:1px 2px; font-weight:bold; width:40%; word-break:break-word;">${k}</td>
                <td style="padding:1px 2px; word-break:break-word;">${v}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      `;

      const btnBox = document.getElementById('btn-container');
      btnBox.innerHTML = '';

      // [A] 카테고리 선택 화면
      if (!data.scenario) {
        Object.keys(utteranceData).forEach(cat => {
          const btn = document.createElement('button');
          btn.className = 'action-btn btn-choice';
          btn.innerText = cat;
          btn.onclick = () => {
            data.scenario = cat;
            data.tree = [];
            refreshUI();
          };
          btnBox.appendChild(btn);
        });
        return;
      }

      // [B] 트리 렌더링 함수
      function renderTree(tree, depth = 0) {
  tree.forEach((node, idx) => {
    const btn = document.createElement('button');
    btn.className = `action-btn btn-${node.type}`;
    btn.innerText = node.label;
    if (node.text) btn.title = tagEngine(node.text, data.eoc, userSettings);
    btn.onclick = () => { tree.splice(idx + 1); refreshUI(); };
    btnBox.appendChild(btn);
    const marker = document.createElement('div'); marker.className = 'branch-marker'; btnBox.appendChild(marker); // 줄바꿈 마커 추가
    if (node.children && node.children.length > 0) renderTree(node.children, depth + 1);
  });
}

      // 트리 렌더링
      renderTree(data.tree);

      // 현재 단계의 선택지 표시
      const currentStep = data.tree.length === 0 ? 'start' : data.tree[data.tree.length - 1].next;
      const options = utteranceData[data.scenario][currentStep] || [];

      // 분기 마커 추가 (선택지가 있을 때만)
      if (options.length > 0) {
        const marker = document.createElement('div');
        marker.className = 'branch-marker';
        btnBox.appendChild(marker);
      }

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = `action-btn btn-${opt.type}`;
        btn.innerText = opt.label;
        
        if (opt.text) btn.title = tagEngine(opt.text, data.eoc, userSettings);

        btn.onclick = () => {
          // 예외 버튼은 choice처럼 다음 선택지만 표시 (복사 안함)
          if (opt.type === 'exception') {
            data.tree.push({
              step: currentStep,
              label: opt.label,
              type: opt.type,
              text: opt.text,
              next: opt.next,
              children: []
            });
            refreshUI();
            return;
          }
          
          // 트리에 추가
          data.tree.push({
            step: currentStep,
            label: opt.label,
            type: opt.type,
            text: opt.text,
            next: opt.next,
            children: []
          });

          // 텍스트 복사 (copy 타입만)
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

    // 퀵버튼 렌더링 함수 (항상 표시)
    window.renderQuickButtons = function() {
      const quickBox = document.getElementById('quick-btn-container');
      if (!quickBox) return;
      
      quickBox.innerHTML = '';
      const quickBtns = userSettings.quickButtons || [];
      
      if (quickBtns.length === 0) {
        // 비어있을 때 안내 메시지
        const hint = document.createElement('div');
        hint.style.fontSize = '9px';
        hint.style.color = '#888';
        hint.style.padding = '2px 4px';
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
        document.getElementById('set-name').value = userSettings.name || ""; 
        document.getElementById('quick-buttons').value = JSON.stringify(userSettings.quickButtons || [], null, 2);
      } else {
        // 초기값 설정
        document.getElementById('quick-buttons').value = '[]';
      }
      renderQuickButtons();
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
      document.getElementById('eoc-info-view').classList.add('stealth');
      document.getElementById('sms-view').classList.add('stealth');
      document.getElementById('eoc-detail-view').classList.toggle('stealth'); 
    };

    document.getElementById('toggle-eoc-info').onclick = () => {
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth');
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('sms-view').classList.add('stealth');
      const view = document.getElementById('eoc-info-view');
      view.classList.toggle('stealth');
      if (!view.classList.contains('stealth')) {
        showEOCInfo();
      }
    };

    document.getElementById('toggle-sms').onclick = () => {
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('calculator-view').classList.add('stealth');
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('eoc-info-view').classList.add('stealth');
      const view = document.getElementById('sms-view');
      view.classList.toggle('stealth');
      if (!view.classList.contains('stealth')) {
        showSMS();
      }
    };

    document.getElementById('toggle-calculator').onclick = () => {
      document.getElementById('eoc-detail-view').classList.add('stealth');
      document.getElementById('settings-view').classList.add('stealth');
      document.getElementById('eoc-info-view').classList.add('stealth');
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
      document.getElementById('eoc-info-view').classList.add('stealth');
      document.getElementById('sms-view').classList.add('stealth');
      document.getElementById('settings-view').classList.toggle('stealth'); 
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

    document.getElementById('save-quick-settings').onclick = () => { 
      userSettings.name = document.getElementById('set-name').value;
      try {
        const quickValue = document.getElementById('quick-buttons').value.trim();
        userSettings.quickButtons = quickValue ? JSON.parse(quickValue) : [];
        chrome.storage.local.set({userSettings}); 
        alert("퀵 버튼 저장됨"); 
        renderQuickButtons();
        refreshUI();
      } catch (e) {
        alert("퀵 버튼 JSON 형식 오류:\n" + e.message);
      }
    };

    document.getElementById('save-sms-settings').onclick = () => {
      try {
        const customerValue = document.getElementById('sms-customer').value.trim();
        const partnerValue = document.getElementById('sms-partner').value.trim();
        const storeValue = document.getElementById('sms-store').value.trim();
        
        userSettings.smsTemplates = {
          "고객": customerValue ? JSON.parse(customerValue) : [],
          "배달파트너": partnerValue ? JSON.parse(partnerValue) : [],
          "스토어": storeValue ? JSON.parse(storeValue) : []
        };
        
        chrome.storage.local.set({userSettings}); 
        alert("SMS 설정 저장됨"); 
      } catch (e) {
        alert("SMS 템플릿 JSON 형식 오류:\n" + e.message);
      }
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
}

function getTid() { 
  return location.pathname.match(/tickets\/(\d+)/)?.[1] || 'test-env'; 
}

// ============================================================================
// [추가 기능] EOC 정보 파싱 및 표시
// ============================================================================

// 헬퍼 함수
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

// EOC 데이터 파싱 (EOC 페이지에서 직접 파싱)
function parseOrderFromHTML() {
  const doc = document;
  const result = {
    주문정보: {},
    주문메뉴: [],
    결제: {},
    배달지: {},
    배달작업: {},
    스토어: {},
    쿠리어: {},
    이슈내용: {},
    보상내역: [],
    이력: []
  };

  // 1. 주문정보
  const orderInfoCard = findCardByHeader(doc, '주문정보');
  if (orderInfoCard) {
    const rows = orderInfoCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const valueCell = row.querySelector('td:last-child');
      
      if (label === '결제 금액' && valueCell) {
        const salesPriceText = valueCell.textContent;
        const match = salesPriceText.match(/판매가격:\s*₩([\d,]+)/);
        if (match) {
          result.주문정보.판매가격 = parseInt(match[1].replace(/,/g, ''));
        }
      } else if (label && label.startsWith('ETA') && valueCell) {
        const timeDiv = valueCell.querySelector('div');
        if (timeDiv) {
          const timeText = timeDiv.textContent.trim();
          const timeMatch = timeText.match(/최초시간\s+(\d{2}):(\d{2})/);
          if (timeMatch) {
            const hours = timeMatch[1];
            const minutes = timeMatch[2];
            result.주문정보[label] = `${hours}:${minutes}`;
            result.주문정보[`${label}_시각`] = `${hours}시 ${minutes}분`;
          }
        }
      } else if (label && valueCell) {
        result.주문정보[label] = valueCell.textContent.trim();
      }
    });
  }

  // 2. 주문 메뉴
  const orderMenuCard = findCardByHeader(doc, '주문 메뉴');
  if (orderMenuCard) {
    const menuRows = orderMenuCard.querySelectorAll('.el-table__body tbody tr');
    menuRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const details = cells[2].textContent.trim();
        result.주문메뉴.push({ details });
      }
    });
  }

  // 3. 결제
  const paymentCard = findCardByHeader(doc, '결제');
  if (paymentCard) {
    const rows = paymentCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const value = row.querySelector('td:last-child')?.textContent.trim();
      if (label && value) {
        result.결제[label] = value;
      }
    });

    // 주문결제내역
    result.결제.주문결제내역 = [];
    const paymentRows = paymentCard.querySelectorAll('.el-table__body tbody tr');
    let foundCouponTable = false;
    
    paymentRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (!foundCouponTable && cells.length >= 4) {
        const 조치종류 = cells[1].textContent.trim();
        const 생성시간 = cells[2].textContent.trim();
        const 성공 = !!cells[3].querySelector('.el-icon-check');
        result.결제.주문결제내역.push({ 조치종류, 생성시간, 성공 });
      }
    });

    // 쿠폰 (상품할인 + 디쉬할인만)
    const couponHeader = Array.from(paymentCard.querySelectorAll('h4')).find(h => h.textContent.includes('쿠폰'));
    if (couponHeader) {
      const couponTable = couponHeader.nextElementSibling;
      if (couponTable && couponTable.classList.contains('el-table')) {
        result.결제.쿠폰 = [];
        let 상품할인합 = 0;
        
        const couponRows = couponTable.querySelectorAll('.el-table__body tbody tr');
        couponRows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3) {
            const 할인유형 = cells[1].textContent.trim();
            const 할인가격문자열 = cells[2].textContent.trim();
            const 할인가격 = parseInt(할인가격문자열.replace(/[^\d]/g, ''));
            
            if (할인유형 === '상품 할인' || 할인유형 === '디쉬 할인') {
              result.결제.쿠폰.push({ 할인유형, 할인가격: 할인가격문자열 });
              상품할인합 += 할인가격;
            }
          }
        });
        
        result.결제.상품할인합계 = 상품할인합;
      }
    }
  }

  // 4. 배달지
  const deliveryAddressCard = findCardByHeader(doc, '배달지');
  if (deliveryAddressCard) {
    const rows = deliveryAddressCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const value = row.querySelector('td:last-child')?.textContent.trim();
      if (label && value) {
        result.배달지[label] = value;
      }
    });
  }

  // 5. 배달 작업
  const deliveryTaskCard = findCardByHeader(doc, '배달 작업');
  if (deliveryTaskCard) {
    const rows = deliveryTaskCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const value = row.querySelector('td:last-child')?.textContent.trim();
      if (label && value) {
        result.배달작업[label] = value;
      }
    });
  }

  // 6. 스토어
  const storeCard = findCardByHeader(doc, '스토어');
  if (storeCard) {
    const rows = storeCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const value = row.querySelector('td:last-child')?.textContent.trim();
      if (label && value) {
        result.스토어[label] = value;
      }
    });
  }

  // 7. 쿠리어
  const courierCard = findCardByHeader(doc, '쿠리어');
  if (courierCard) {
    const rows = courierCard.querySelectorAll('.order-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const value = row.querySelector('td:last-child');
      if (label && value) {
        if (label === '쿠리어 타입') {
          const checkedRadio = value.querySelector('.el-radio.is-checked .el-radio__label');
          result.쿠리어[label] = checkedRadio ? checkedRadio.textContent.trim() : '';
        } else {
          result.쿠리어[label] = value.textContent.trim();
        }
      }
    });
  }

  // 8. 이슈 내용
  const issueCard = findCardByHeader(doc, '이슈 내용');
  if (issueCard) {
    const rows = issueCard.querySelectorAll('.inquiry-detail-table tr');
    rows.forEach(row => {
      const label = row.querySelector('td:first-child')?.textContent.trim();
      const value = row.querySelector('td:last-child')?.textContent.trim();
      if (label && value) {
        result.이슈내용[label] = value;
      }
    });
  }

  // 9. 보상내역
  const compensationCard = findCardByHeader(doc, '보상내역');
  if (compensationCard) {
    const compRows = compensationCard.querySelectorAll('.el-table__body tbody tr');
    compRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 5) {
        result.보상내역.push({
          reason: cells[0].textContent.trim(),
          amount: cells[1].textContent.trim(),
          processor: cells[2].textContent.trim(),
          processedAt: cells[3].textContent.trim(),
          status: cells[4].textContent.trim()
        });
      }
    });
  }

  // 10. 이력
  const historyCard = findCardByHeader(doc, '이력');
  if (historyCard) {
    const historyRows = historyCard.querySelectorAll('.el-table__body tbody tr');
    historyRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 6) {
        const action = cells[2].textContent.trim();
        
        result.이력.push({
          taskId: cells[0].textContent.trim(),
          status: cells[1].textContent.trim(),
          action: action,
          eta: cells[3].textContent.trim(),
          courierId: cells[4].textContent.trim(),
          createdInfo: cells[5].textContent.trim()
        });
        
        // 배달 완료 시각 추출
        if (action === '배달 완료') {
          const createdInfo = cells[5].textContent.trim();
          const timeMatch = createdInfo.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
          if (timeMatch) {
            const [_, year, month, day, hours, minutes] = timeMatch;
            result.배달완료시각 = `${hours}:${minutes}`;
            result.배달완료시각_한글 = `${hours}시 ${minutes}분`;
            result.배달완료일시 = `${year}-${month}-${day} ${hours}:${minutes}`;
            
            // ETA1과 시간 차이 계산
            const eta1 = result.주문정보["ETA 1 (머천트 수락)"];
            if (eta1) {
              const [eta1Hours, eta1Minutes] = eta1.split(':').map(Number);
              const [completeHours, completeMinutes] = [parseInt(hours), parseInt(minutes)];
              
              const eta1TotalMinutes = eta1Hours * 60 + eta1Minutes;
              const completeTotalMinutes = completeHours * 60 + completeMinutes;
              const diffMinutes = completeTotalMinutes - eta1TotalMinutes;
              
              result.배달지연시간 = diffMinutes;
              
              if (diffMinutes > 0) {
                result.배달지연시간_한글 = `${diffMinutes}분 지연`;
              } else if (diffMinutes < 0) {
                result.배달지연시간_한글 = `${Math.abs(diffMinutes)}분 조기배달`;
              } else {
                result.배달지연시간_한글 = `정시 배달`;
              }
            }
          }
        }
      }
    });
  }

  return result;
}

// EOC 데이터 파싱 (Zendesk용 - chrome.storage에서 가져온 데이터 파싱)
function parseOrderFromStorage(eocData) {
  // chrome.storage에서 받은 데이터를 구조화
  return {
    주문정보: eocData,
    주문메뉴: eocData['주문메뉴'] || [],
    결제: { 상품할인합계: eocData["상품할인"] || 0 },
    스토어: { 이름: eocData["이름"] || '', 전화번호: eocData["전화번호"] || '' },
    쿠리어: { '쿠리어 타입': eocData["쿠리어 타입"] || '', '쿠리어 ID': eocData["쿠리어 ID"] || '', 전화번호: eocData["쿠리어 전화번호"] || '' }
  };
}


// 기본 SMS 템플릿
function getDefaultSMSTemplates() {
  return {
    "고객": [
      { "label": "배달지연", "text": "고객님, 주문하신 음식이 배달 지연되고 있습니다. 죄송합니다." },
      { "label": "조리지연", "text": "고객님, 매장에서 조리가 지연되고 있습니다. 죄송합니다." },
      { "label": "[내용작성]", "text": "" },
      { "label": "[내용작성]", "text": "" }
    ],
    "배달파트너": [
      { "label": "픽업요청", "text": "픽업 부탁드립니다." },
      { "label": "정정배달", "text": "정정배달 요청합니다." },
      { "label": "[내용작성]", "text": "" },
      { "label": "[내용작성]", "text": "" }
    ],
    "스토어": [
      { "label": "조리독촉", "text": "조리 진행 부탁드립니다." },
      { "label": "재조리", "text": "재조리 요청합니다." },
      { "label": "[내용작성]", "text": "" },
      { "label": "[내용작성]", "text": "" }
    ]
  };
}

// EOC 정보 탭 표시
function showEOCInfo() {
  const view = document.getElementById('eoc-info-view');
  if (!view) return;

  const tid = getTid();
  const data = ticketStore[tid];
  if (!data || !data.eoc) {
    view.innerHTML = '<div style="padding:8px;color:#e53935;">EOC 데이터가 없습니다</div>';
    return;
  }

  try {
    const orderData = parseOrderFromStorage(data.eoc);
    
    // 주문 유형
    let orderType = '한집배달';
    if (data.eoc["주문 유형"] && data.eoc["주문 유형"].includes('세이브')) {
      orderType = '무료배달';
    }

    // 결제시각 (ETA1이나 다른 시각 정보 활용)
    let paymentTime = data.eoc["_ETA1_시각"] || '';

    view.innerHTML = `
      <div style="padding:2px;font-size:9px;">
        <button id="btn-toggle-raw" style="width:100%;padding:2px;margin-bottom:2px;cursor:pointer;background:#f0f0f0;border:1px solid #ccc;">
          EOC 원문 보기 ▼
        </button>
        <div id="raw-data-container" style="display:none;max-height:300px;overflow-y:auto;padding:4px;background:#fafafa;border:1px solid #ddd;font-size:8px;white-space:pre-wrap;"></div>
        <div style="padding:2px;line-height:1.6;">
          <div class="copyable-row" data-copy="${orderType}" style="padding:2px 0;cursor:pointer;">주문유형 | ${orderType}</div>
          <div class="copyable-row" data-copy="${data.eoc['고유 주문 ID'] || ''}" style="padding:2px 0;cursor:pointer;">고유번호 | ${data.eoc['고유 주문 ID'] || '-'}</div>
          <div class="copyable-row" data-copy="${data.eoc['이름'] || ''}" style="padding:2px 0;cursor:pointer;">매장명 | ${data.eoc['이름'] || '-'}</div>
          <div class="copyable-row" data-copy="${data.eoc['전화번호'] || ''}" style="padding:2px 0;cursor:pointer;">전화번호 | ${data.eoc['전화번호'] || '-'}</div>
          <div class="copyable-row" data-copy="${paymentTime}" style="padding:2px 0;cursor:pointer;">결제시각 | ${paymentTime}</div>
          <div class="copyable-row" data-copy="${data.eoc['축약형 주문 ID'] || ''}" style="padding:2px 0;cursor:pointer;">축약번호 | ${data.eoc['축약형 주문 ID'] || '-'}</div>
          <hr style="margin:2px 0;border:none;border-top:1px solid #ddd;">
          <div style="font-weight:bold;margin:2px 0;">주문 메뉴</div>
          ${(data.eoc['주문메뉴'] || []).map(menu => `<div class="copyable-row" data-copy="${menu}" style="padding:2px 0;cursor:pointer;">${menu}</div>`).join('') || '<div style="color:#999;">메뉴 정보 없음</div>'}
          <hr style="margin:2px 0;border:none;border-top:1px solid #ddd;">
          <div class="copyable-row" data-copy="${data.eoc['판매금액'] || '0'}" style="padding:2px 0;cursor:pointer;">판매가격 | ₩${(data.eoc['판매금액'] || 0).toLocaleString()}</div>
          <div class="copyable-row" data-copy="${data.eoc['상품할인'] || '0'}" style="padding:2px 0;cursor:pointer;">상품할인 | ₩${(data.eoc['상품할인'] || 0).toLocaleString()}</div>
          <hr style="margin:2px 0;border:none;border-top:1px solid #ddd;">
          <div class="copyable-row" data-copy="${data.eoc['쿠리어 타입'] || ''}" style="padding:2px 0;cursor:pointer;">파트너유형 | ${data.eoc['쿠리어 타입'] || '-'}</div>
          <div class="copyable-row" data-copy="${data.eoc['쿠리어 ID'] || ''}" style="padding:2px 0;cursor:pointer;">파트너ID | ${data.eoc['쿠리어 ID'] || '-'}</div>
          <div class="copyable-row" data-copy="${data.eoc['쿠리어 전화번호'] || ''}" style="padding:2px 0;cursor:pointer;">파트너전화 | ${data.eoc['쿠리어 전화번호'] || '-'}</div>
        </div>
      </div>
    `;

    // 복사 기능
    view.querySelectorAll('.copyable-row').forEach(row => {
      row.onclick = function() {
        const text = this.getAttribute('data-copy');
        navigator.clipboard.writeText(text).then(() => {
          this.style.background = '#e8f5e9';
          setTimeout(() => { this.style.background = ''; }, 200);
        });
      };
    });

    // 원문 토글
    const toggleBtn = view.querySelector('#btn-toggle-raw');
    const rawContainer = view.querySelector('#raw-data-container');
    
    toggleBtn.onclick = function() {
      if (rawContainer.style.display === 'none') {
        // 원문 생성
        rawContainer.textContent = JSON.stringify(data.eoc, null, 2);
        rawContainer.style.display = 'block';
        toggleBtn.textContent = 'EOC 원문 닫기 ▲';
      } else {
        rawContainer.style.display = 'none';
        toggleBtn.textContent = 'EOC 원문 보기 ▼';
      }
    };

  } catch (error) {
    console.error('EOC Info error:', error);
    view.innerHTML = '<div style="padding:8px;color:#e53935;">정보 로드 오류</div>';
  }
}

// SMS 탭 표시
function showSMS() {
  const view = document.getElementById('sms-view');
  if (!view) return;

  const smsTemplates = userSettings.smsTemplates || getDefaultSMSTemplates();

  const getGroupEmoji = (group) => {
    const emojis = { '고객': '👤', '배달파트너': '🛵', '스토어': '🏪' };
    return emojis[group] || '📝';
  };

  view.innerHTML = `
    <div style="padding:4px;font-size:9px;">
      <div style="text-align:center;font-weight:bold;padding:4px;background:#f5f5f5;border-bottom:1px solid #ddd;">SMS 발송</div>
      
      ${Object.entries(smsTemplates).map(([group, templates]) => `
        <div style="margin:6px 0;border-bottom:1px solid #eee;padding-bottom:4px;">
          <div style="font-weight:bold;padding:2px 0;font-size:10px;">${getGroupEmoji(group)} ${group}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;">
            ${templates.map(template => `
              <button class="btn-sms" data-text="${template.text}" style="padding:3px 6px;font-size:9px;background:#66bb6a;color:white;border:none;border-radius:2px;cursor:pointer;text-align:left;">
                ${template.label}
              </button>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  // SMS 버튼 이벤트
  view.querySelectorAll('.btn-sms').forEach(btn => {
    btn.onclick = function() {
      const text = this.getAttribute('data-text');
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          this.style.background = '#4caf50';
          setTimeout(() => { this.style.background = '#66bb6a'; }, 200);
        });
      }
    };
  });
}