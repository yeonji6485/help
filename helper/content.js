// [1] 발화 데이터 정의 (사용자 엑셀 기반)
const utteranceData = {
  "customer_change_mind": {
    "start": [
      { label: "사유언급 X", text: "네 고객님, 주문하신 매장은 {{매장명}}으로 확인되는데요, 취소 사유를 여쭤봐도 될까요?", next: "wait_step" },
      { label: "사유언급 O", text: "네 고객님, 확인 감사합니다. 매장에 확인해 보겠습니다.", next: "wait_step" }
    ],
    "wait_step": [
      { label: "대기 요청", text: "잠시만 기다려주시겠습니까?", next: "check_cooking" }
    ],
    "check_cooking": [
      { label: "조리 전", text: "매장에 확인해보니 아직 조리 전입니다. 취소 도와드릴까요?", next: "start" },
      { label: "조리 중", text: "매장이 이미 조리 중인 것으로 확인됩니다. 빠른 조리 요청 드릴 테니 받아보시는 건 어떨까요?", next: "final_response" }
    ],
    "final_response": [
      { label: "고객 수긍", text: "양해해주셔서 감사합니다. 맛있게 드세요!", next: "start" },
      { label: "고객 미수긍", text: "취소 원하신다면 다시 확인해 보겠습니다.", next: "start" }
    ]
  }
};

// [2] 상태 관리 변수
let ticketData = {}; 
let lastPath = location.pathname;

// [3] UI 생성
const panel = document.createElement('div');
panel.id = 'zd-helper-panel';
panel.className = 'hover-mode';
panel.innerHTML = `
  <div class="header">
    <span id="timer-display">00:00</span>
    <div><button id="pin-btn">📌</button><button id="stealth-btn">👻</button></div>
  </div>
  <div id="log-container"></div>
  <div id="btn-container"></div>
  <div class="footer">EOC: <span id="eoc-var">매장명(샘플)</span></div>
`;
document.body.appendChild(panel);

// [4] 핵심 함수들
function getTicketId() {
  const match = window.location.pathname.match(/tickets\/(\d+)/);
  return match ? match[1] : 'dashboard';
}

function updateDisplay() {
  const tid = getTicketId();
  if (!ticketData[tid]) {
    ticketData[tid] = { history: [], step: 'start', lastActionTime: null };
  }
  
  const current = ticketData[tid];
  
  // 로그 렌더링
  const logBox = document.getElementById('log-container');
  logBox.innerHTML = current.history.map(h => `
    <div class="log-item"><div class="log-time">${h.time}</div><div class="log-label">${h.label}</div></div>
  `).join('');
  logBox.scrollTop = logBox.scrollHeight;

  // 버튼 렌더링
  const btnBox = document.getElementById('btn-container');
  btnBox.innerHTML = '';
  const options = utteranceData["customer_change_mind"][current.step];

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.innerText = opt.label;
    btn.onclick = () => {
      const now = new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const storeName = document.getElementById('eoc-var').innerText;
      
      // 기록 저장
      current.history.push({ label: opt.label, time: now });
      current.step = opt.next;
      current.lastActionTime = Date.now();

      // 복사
      const msg = opt.text.replace("{{매장명}}", storeName);
      navigator.clipboard.writeText(msg);
      updateDisplay();
    };
    btnBox.appendChild(btn);
  });
}

// [5] 타이머 및 감시 로직
setInterval(() => {
  const tid = getTicketId();
  if (ticketData[tid] && ticketData[tid].lastActionTime) {
    const diff = Math.floor((Date.now() - ticketData[tid].lastActionTime) / 1000);
    const m = Math.floor(diff / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    document.getElementById('timer-display').innerText = `${m}:${s}`;
  } else {
    document.getElementById('timer-display').innerText = "00:00";
  }

  // SPA URL 변경 감지
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    updateDisplay();
  }
}, 1000);

// [6] 이벤트 리스너
document.getElementById('pin-btn').onclick = () => panel.classList.toggle('hover-mode');
document.getElementById('stealth-btn').onclick = () => panel.classList.toggle('stealth');
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') panel.classList.toggle('stealth');
});

// 초기 실행
updateDisplay();