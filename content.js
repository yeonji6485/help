const isEOC = location.host.includes('coupang.net');
const isZD = location.host.includes('zendesk.com') || location.host.includes('google.com');

// ============================================================================
// [EOC] 데이터 수집 (기존 로직 유지)
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
        }
      });
      eoc원문.주문메뉴 = menuList.join('\n\n');
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
  }

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
            if (status.includes('픽업') || status.includes('Pick Up') || status.includes('배달 시작')) tags["픽업시각"] = timeStr;
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
// [Zendesk] UI 및 태그 치환 엔진 (구조 전면 개편)
// ============================================================================
if (isZD) {
  let ticketStore = {}, utteranceData = {}, userSettings = { name: "", quickButtons: [], smsTemplates: [] }, lastPath = location.pathname;

  fetch(chrome.runtime.getURL('data_generated.json')).then(r => r.json()).then(data => { 
    utteranceData = data.scenarios; initUI(); 
  });

  function initUI() {
    const panel = document.createElement('div');
    panel.id = 'zd-helper-panel';
    Object.assign(panel.style, {
        position: 'fixed', top: '10px', right: '10px', width: '340px',
        backgroundColor: '#fff', border: '1px solid #ccc',
        boxShadow: '0 4px 15px rgba(0,0,0,0.15)', zIndex: '9999',
        display: 'flex', flexDirection: 'column',
        maxHeight: '90vh', borderRadius: '6px', fontFamily: 'sans-serif'
    });

    panel.innerHTML = `
      <div class="header" style="padding:10px; background:#f8f9fa; border-bottom:1px solid #ddd; cursor:pointer; display:flex; justify-content:space-between; align-items:center; border-radius: 6px 6px 0 0;" title="클릭: 접기/펼치기 | 드래그: 이동">
        <div>
            <span id="timer-display" style="font-weight:bold; color:#0052cc; margin-right:8px; font-family: monospace; font-size:13px;">00:00</span>
            <span id="info-header" style="font-size:11px; color:#444; font-weight:bold;">연동 대기 중...</span>
        </div>
        <div style="display:flex; gap:6px;">
            <button id="home-btn" title="처음으로 (스크립트 리셋)" style="border:none; background:none; cursor:pointer; font-size:14px;">🏠</button>
        </div>
      </div>
      
      <div id="panel-content" style="display:flex; flex-direction:column; flex:1; overflow:hidden; background-color: #fff;">
        
        <div id="content-scroll-area" style="flex:1; overflow-y:auto; padding:0; position:relative;">
            
            <div id="view-home" class="tab-view" style="height:100%; display:flex; flex-direction:column;">
                <div id="script-container" style="flex:1; overflow-y:auto; padding:10px; min-height:100px;">
                    <div id="btn-container"></div>
                </div>
                
                <div id="drag-divider" style="height:6px; background:#f1f3f5; cursor:ns-resize; border-top:1px solid #e9ecef; border-bottom:1px solid #e9ecef; display:flex; justify-content:center; align-items:center;">
                    <div style="width:20px; height:2px; background:#ccc; border-radius:1px;"></div>
                </div>

                <div id="quick-btn-area" style="height:200px; overflow-y:auto; padding:10px; background:#fff;">
                    <div style="font-size:11px; color:#888; margin-bottom:6px; font-weight:bold;">✨ 퀵 버튼</div>
                    <div id="quick-btn-container"></div>
                </div>
            </div>

            <div id="view-eoc" class="tab-view" style="display:none;">
                <div id="eoc-detail-view"></div>
                <div id="anbunga-container"></div>
            </div>

            <div id="view-sms" class="tab-view" style="display:none; padding:10px;">
                <div id="sms-container"></div>
            </div>
            
            <div id="view-calc" class="tab-view" style="display:none; padding:12px;">
                <h4 style="margin: 0 0 12px 0; font-size:12px; color:#333;">🧮 안분가 계산기</h4>
                <div id="calc-ratio-box" style="background: #e3f2fd; padding: 10px; border: 1px solid #bbdefb; border-radius: 4px; margin-bottom: 12px;">
                    <div style="color:#1565c0; font-size:11px;">데이터 대기 중...</div>
                </div>
                <div style="margin-bottom: 12px;">
                    <label style="display: block; margin-bottom: 4px; font-size: 11px; color: #555;">보상금액 입력</label>
                    <input id="calc-input" type="number" placeholder="예: 5000" style="width: 100%; padding: 8px; border: 1px solid #ddd; font-size: 12px; border-radius: 4px; box-sizing: border-box;">
                </div>
                <button id="calc-btn" style="width: 100%; padding: 10px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">계산 및 복사</button>
                <div id="calc-result" style="margin-top: 12px; padding: 10px; background: #e8f5e9; border: 1px solid #c8e6c9; border-radius: 4px; font-weight: bold; text-align: center; display: none; font-size: 13px; color: #2e7d32;"></div>
            </div>

            <div id="view-settings" class="tab-view" style="display:none; padding:12px;">
                <label style="display:block; margin-bottom:4px; font-size:11px; font-weight:bold;">상담사 이름</label>
                <input id="set-name" type="text" placeholder="이름 입력" style="width:100%; padding:8px; margin-bottom:12px; border:1px solid #ddd; border-radius:4px; box-sizing: border-box;">
                
                <label style="display:block; margin-bottom:4px; font-size:11px; font-weight:bold;">퀵 버튼 JSON (그룹형)</label>
                <textarea id="quick-buttons" style="width:100%; height:80px; padding:8px; margin-bottom:12px; border:1px solid #ddd; border-radius:4px; box-sizing: border-box; font-family:monospace; font-size:11px;"></textarea>
                
                <label style="display:block; margin-bottom:4px; font-size:11px; font-weight:bold;">SMS 템플릿 JSON (그룹형)</label>
                <textarea id="sms-templates" style="width:100%; height:80px; padding:8px; margin-bottom:12px; border:1px solid #ddd; border-radius:4px; box-sizing: border-box; font-family:monospace; font-size:11px;"></textarea>
                
                <button id="save-settings" style="width:100%; padding:10px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight:bold;">설정 저장</button>
            </div>

        </div>

        <div class="footer" style="padding:0; display:flex; border-top:1px solid #ddd; background:#fff; height: 44px; flex-shrink:0;">
            <button onclick="window.switchTab('view-home', this)" class="footer-btn active" style="flex:1; border:none; background:#e3f2fd; color:#1565c0; font-weight:bold; font-size:11px; cursor:pointer; border-right:1px solid #eee;">🏠 홈</button>
            <button onclick="window.switchTab('view-eoc', this)" class="footer-btn" style="flex:1; border:none; background:transparent; font-size:11px; cursor:pointer; border-right:1px solid #eee; color:#666;">📋 EOC</button>
            <button onclick="window.switchTab('view-sms', this)" class="footer-btn" style="flex:1; border:none; background:transparent; font-size:11px; cursor:pointer; border-right:1px solid #eee; color:#666;">💬 SMS</button>
            <button onclick="window.switchTab('view-calc', this)" class="footer-btn" style="flex:1; border:none; background:transparent; font-size:11px; cursor:pointer; border-right:1px solid #eee; color:#666;">🧮 계산</button>
            <button onclick="window.switchTab('view-settings', this)" class="footer-btn" style="flex:1; border:none; background:transparent; font-size:11px; cursor:pointer; color:#666;">⚙️ 설정</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // [전역 탭 전환 함수]
    window.switchTab = (viewId, btnEl) => {
        document.querySelectorAll('.tab-view').forEach(el => el.style.display = 'none');
        document.getElementById(viewId).style.display = (viewId === 'view-home') ? 'flex' : 'block';
        
        document.querySelectorAll('.footer-btn').forEach(b => {
            b.style.background = 'transparent'; b.style.color = '#666'; b.style.fontWeight = 'normal';
        });
        btnEl.style.background = '#e3f2fd'; btnEl.style.color = '#1565c0'; btnEl.style.fontWeight = 'bold';
    };

    // [Resizer 로직] 스크립트창 vs 퀵버튼창 비율 조절
    const divider = document.getElementById('drag-divider');
    const scriptBox = document.getElementById('script-container');
    const quickBox = document.getElementById('quick-btn-area');
    let startY, startH;
    divider.addEventListener('mousedown', (e) => {
        startY = e.clientY; startH = scriptBox.offsetHeight;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
    function onMouseMove(e) {
        const delta = e.clientY - startY;
        scriptBox.style.flex = 'none'; // flex-grow 해제
        scriptBox.style.height = (startH + delta) + 'px';
        // 퀵버튼 영역은 flex:1 로 자동 조절되거나 높이를 뺌
        // 여기선 간단히 scriptBox 높이만 조절하고 quickBox는 flex로 남은 공간 차지하게 둠
        // 하지만 view-home이 flex-col이므로 scriptBox 높이 고정시 quickBox가 밀림.
        // quickBox 높이도 같이 조절하려면 전체 높이에서 빼야함.
        // 간단히: scriptBox flex-basis 조절
    }
    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }

    // [헤더 드래그 & 토글]
    const header = panel.querySelector('.header');
    const content = document.getElementById('panel-content');
    let isDragging=false, dragStartX, dragStartY, panelStartX, panelStartY, isClick=true;
    header.addEventListener('mousedown', (e) => { 
      if(e.target.tagName==='BUTTON') return;
      isDragging=true; isClick=true; dragStartX=e.clientX; dragStartY=e.clientY;
      const r = panel.getBoundingClientRect(); panelStartX=r.left; panelStartY=r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if(!isDragging) return;
      if(Math.abs(e.clientX-dragStartX)>5 || Math.abs(e.clientY-dragStartY)>5) isClick=false;
      panel.style.left = Math.max(0, Math.min(panelStartX + (e.clientX-dragStartX), window.innerWidth-panel.offsetWidth)) + 'px';
      panel.style.top = Math.max(0, Math.min(panelStartY + (e.clientY-dragStartY), window.innerHeight-panel.offsetHeight)) + 'px';
      panel.style.right='auto';
    });
    document.addEventListener('mouseup', (e) => {
      if(isDragging) {
        isDragging=false;
        if(isClick && !e.target.closest('button')) {
            content.style.display = (content.style.display==='none') ? 'flex' : 'none';
            panel.style.height = 'auto';
        }
      }
    });

    document.getElementById('home-btn').onclick = () => { if(ticketStore[getTid()]) { ticketStore[getTid()].scenario = null; ticketStore[getTid()].tree = []; refreshUI(); }};
    
    // 색상 매핑 함수 (파스텔톤)
    function getPastelColor(colorName) {
        const colors = {
            blue: { bg: '#e3f2fd', text: '#1565c0', border: '#bbdefb' },
            red: { bg: '#ffebee', text: '#c62828', border: '#ffcdd2' },
            green: { bg: '#e8f5e9', text: '#2e7d32', border: '#c8e6c9' },
            yellow: { bg: '#fffde7', text: '#f9a825', border: '#fff9c4' },
            purple: { bg: '#f3e5f5', text: '#6a1b9a', border: '#e1bee7' },
            gray: { bg: '#f5f5f5', text: '#424242', border: '#e0e0e0' }
        };
        return colors[colorName] || colors.gray;
    }

    // 버튼 렌더러 (그룹형)
    function renderGroupedButtons(containerId, data) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';
        if(!data || !Array.isArray(data)) return;

        data.forEach(group => {
            const style = getPastelColor(group.color);
            const groupDiv = document.createElement('div');
            groupDiv.style.marginBottom = '8px';
            
            const title = document.createElement('div');
            title.innerText = group.group || '그룹없음';
            title.style.fontSize = '10px';
            title.style.color = '#888';
            title.style.marginBottom = '4px';
            groupDiv.appendChild(title);

            const btnWrap = document.createElement('div');
            btnWrap.style.display = 'flex';
            btnWrap.style.flexWrap = 'wrap';
            btnWrap.style.gap = '4px';

            (group.buttons || []).forEach(btn => {
                const b = document.createElement('button');
                b.innerText = btn.label;
                b.title = tagEngine(btn.text, ticketStore[getTid()]?.eoc || {}, userSettings);
                Object.assign(b.style, {
                    padding: '4px 8px', fontSize: '11px', cursor: 'pointer',
                    backgroundColor: style.bg, color: style.text,
                    border: `1px solid ${style.border}`, borderRadius: '4px',
                    fontWeight: '500'
                });
                b.onclick = () => navigator.clipboard.writeText(tagEngine(btn.text, ticketStore[getTid()]?.eoc || {}, userSettings));
                btnWrap.appendChild(b);
            });
            groupDiv.appendChild(btnWrap);
            container.appendChild(groupDiv);
        });
    }

    document.getElementById('save-settings').onclick = () => {
      userSettings.name = document.getElementById('set-name').value;
      try { 
          userSettings.quickButtons = JSON.parse(document.getElementById('quick-buttons').value || "[]"); 
          userSettings.smsTemplates = JSON.parse(document.getElementById('sms-templates').value || "[]");
      } catch(e) { return alert("JSON 오류: " + e.message); }
      chrome.storage.local.set({userSettings}); alert("저장됨"); refreshUI();
    };

    document.getElementById('calc-btn').onclick = () => {
        const eoc = ticketStore[getTid()]?.eoc?.eoc원문;
        if (!eoc || !eoc.판매가격) return alert('판매금액 정보 없음');
        const s = eoc.판매가격, d = eoc.할인금액 || 0;
        const v = parseFloat(document.getElementById('calc-input').value);
        if(!v) return alert('금액 입력 필요');
        const res = Math.round(((s - d) / s) * v);
        const rd = document.getElementById('calc-result');
        rd.innerText = `${res.toLocaleString()}원 (복사됨)`; rd.style.display = 'block';
        navigator.clipboard.writeText(res.toString());
    };

    window.refreshUI = () => {
      const tid = getTid(); if (!tid) return;
      if (!ticketStore[tid]) ticketStore[tid] = { scenario: null, tree: [], eoc: {} };
      const data = ticketStore[tid], eoc = data.eoc || {};

      if (eoc["고유주문번호"]) {
        document.getElementById('info-header').innerText = `*${eoc["고유주문번호"].slice(-4)} | ${eoc["스토어명"] || ""}`;
      }

      // 1. EOC 뷰 렌더링
      const eocView = document.getElementById('eoc-detail-view');
      if (!data.eoc || Object.keys(data.eoc).length === 0) {
        eocView.innerHTML = '<div style="padding:10px; text-align:center; color:#999; font-size:12px;">주문 데이터가 없습니다.</div>';
      } else {
        const o = eoc.eoc원문 || {};
        const sPhone = (o.스토어번호||"").replace(/-/g,"");
        const cPhone = (o.배달파트너전화||"").replace(/-/g,"");
        const kPhone = (o.고객전화||"").replace(/-/g,"");
        
        // 지연 계산
        let dInfo="-", dCol="#666";
        if(eoc["_ETA1_시"]!=null){
            const eta = eoc["_ETA1_시"]*60 + eoc["_ETA1_분"];
            let cur = 0;
            if(eoc["_배달완료_시"]) {
                cur = parseInt(eoc["_배달완료_시"])*60 + parseInt(eoc["_배달완료_분"]);
                const df = cur - eta; dInfo = (df>0?"+":"")+df+"분(완료)"; dCol=df>0?"#d32f2f":"#1976d2";
            } else {
                const now = new Date(); cur = now.getHours()*60 + now.getMinutes();
                const df = cur - eta; dInfo = (df>0?"+":"")+df+"분(진행)"; dCol=df>0?"#d32f2f":"#388e3c";
            }
        }

        let mHtml = (o.주문메뉴||"").split('\n').filter(l=>l.trim()).map(l=>
            `<div onclick="navigator.clipboard.writeText('${l.replace(/'/g,"\\'")}')" style="cursor:pointer; padding:2px 0;">${l}</div>`
        ).join('');

        eocView.innerHTML = `
          <div style="font-size:11px; padding:10px;">
             <button id="toggle-raw" style="width:100%; margin-bottom:8px; border:1px solid #ddd; background:#f8f9fa; padding:4px; cursor:pointer;">[원문 보기]</button>
             <pre id="raw-view" style="display:none; font-size:10px; background:#f1f1f1; padding:4px; overflow-x:auto;">${JSON.stringify(o, null, 2)}</pre>
             
             <div style="margin-bottom:8px; border-bottom:1px solid #eee; padding-bottom:4px;">
                ${row("유형", o.배달유형)} ${row("번호", o.고유주문번호)} ${row("매장", o.스토어명)} ${row("매장폰", sPhone)}
             </div>
             <div style="margin-bottom:8px; border-bottom:1px solid #eee; padding-bottom:4px;">
                <div style="font-weight:bold; margin-bottom:2px;">메뉴</div>
                <div style="color:#555; line-height:1.4;">${mHtml}</div>
                <div style="margin-top:4px;">${row("판매가",o.판매가격?.toLocaleString())} ${row("할인",o.할인금액?.toLocaleString())}</div>
             </div>
             <div>
                ${row("파트너", o.배달파트너타입)} ${row("기사폰", cPhone)} ${row("고객폰", kPhone)}
                <div style="margin-top:4px; color:${dCol}; font-weight:bold;">지연: ${dInfo}</div>
             </div>
          </div>
        `;
        document.getElementById('toggle-raw').onclick = () => {
            const el = document.getElementById('raw-view'); el.style.display = el.style.display==='none'?'block':'none';
        };
      }

      // 2. 계산기 비율
      const cBox = document.getElementById('calc-ratio-box');
      if(eoc.eoc원문?.판매가격) {
          const s = eoc.eoc원문.판매가격, d = eoc.eoc원문.할인금액||0;
          const r = ((s-d)/s*100).toFixed(2);
          cBox.innerHTML = `<div style="text-align:center; color:#1565c0; font-weight:bold;">적용 비율: ${r}%</div>`;
      } else {
          cBox.innerHTML = `<div style="text-align:center; color:#999;">데이터 없음</div>`;
      }

      // 3. 퀵버튼 & SMS 렌더링
      renderGroupedButtons('quick-btn-container', userSettings.quickButtons);
      renderGroupedButtons('sms-container', userSettings.smsTemplates);

      // 4. 스크립트 버튼 (홈 화면)
      const btnBox = document.getElementById('btn-container'); btnBox.innerHTML = '';
      if (!data.scenario) {
        Object.keys(utteranceData).forEach(cat => {
          const b = document.createElement('button'); b.innerText = cat;
          Object.assign(b.style, { width:'100%', padding:'8px', marginBottom:'4px', cursor:'pointer', background:'#fff', border:'1px solid #ccc', borderRadius:'4px', textAlign:'left' });
          b.onclick = () => { data.scenario = cat; data.tree = []; refreshUI(); };
          btnBox.appendChild(b);
        });
      } else {
        // 트리 렌더링
        const renderTree = (tree) => {
            tree.forEach((n, idx) => {
                const b = document.createElement('button'); b.innerText = n.label;
                Object.assign(b.style, { display:'inline-block', padding:'4px 8px', margin:'2px', cursor:'pointer', background:'#e3f2fd', border:'1px solid #90caf9', borderRadius:'12px', color:'#1565c0', fontSize:'11px' });
                b.onclick = () => { tree.splice(idx + 1); refreshUI(); };
                btnBox.appendChild(b);
            });
            if(tree.length > 0) btnBox.appendChild(document.createElement('hr'));
        };
        renderTree(data.tree);
        
        // 다음 선택지
        const current = data.tree.length === 0 ? 'start' : data.tree[data.tree.length - 1].next;
        const options = utteranceData[data.scenario][current] || [];
        options.forEach(opt => {
            const b = document.createElement('button'); b.innerText = opt.label;
            b.title = tagEngine(opt.text, eoc, userSettings);
            Object.assign(b.style, { width:'100%', padding:'8px', marginBottom:'4px', cursor:'pointer', background:'#fff', border:'1px solid #ccc', borderRadius:'4px', textAlign:'left' });
            b.onclick = () => {
                if(opt.type !== 'exception') data.tree.push({ ...opt, children: [] });
                else data.tree.push({ ...opt, children: [] });
                if (opt.type === 'copy' && opt.text) navigator.clipboard.writeText(tagEngine(opt.text, eoc, userSettings));
                refreshUI();
            };
            btnBox.appendChild(b);
        });
      }
    };

    function row(l, v) { return `<div style="display:flex; justify-content:space-between;"><span style="color:#888;">${l}</span><span>${v||""}</span></div>`; }

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
