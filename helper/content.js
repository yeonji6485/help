const isEOC = location.host.includes('coupang.net');
const isZD = location.host.includes('zendesk.com');

if (isEOC) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-testid="zendesk_order_ticket_async"]');
    if (btn) {
      const allData = {};
      document.querySelectorAll('tr').forEach(tr => {
        if (tr.cells.length >= 2) {
          const key = tr.cells[0].innerText.trim();
          const val = tr.cells[1].innerText.trim().split('\n')[0];
          if (key && val) allData[key] = val;
        }
      });
      chrome.storage.local.set({ "transfer_buffer": { ...allData, _ts: Date.now() } });
    }
  });
}

if (isZD) {
  let ticketStore = {};
  const panel = document.createElement('div');
  panel.id = 'zd-helper-panel';
  panel.className = 'hover-mode';
  panel.innerHTML = `
    <div class="header" id="info-header">연동 대기 중...</div>
    <div id="log-container"></div>
    <div id="eoc-detail-view" class="stealth"></div>
    <div id="btn-container"></div>
    <div class="footer"><button id="toggle-detail">EOC 전체정보</button></div>
  `;
  document.body.appendChild(panel);

  const getTid = () => location.pathname.match(/tickets\/(\d+)/)?.[1];

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.transfer_buffer) {
      const tid = getTid();
      if (tid) {
        ticketStore[tid] = { ...changes.transfer_buffer.newValue, step: 'start', history: [] };
        refreshUI();
      }
    }
  });

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

  function refreshUI() {
    const tid = getTid();
    const head = document.getElementById('info-header');
    const detail = document.getElementById('eoc-detail-view');
    const btnBox = document.getElementById('btn-container');
    const data = ticketStore[tid];

    if (tid && data) {
      const fullId = data["고유 주문 ID"] || "";
      head.innerText = `*${fullId.slice(-4)} | ${data["축약형 주문 ID"] || "---"} | ${data["이름"] || "매장명없음"}`;
      detail.innerHTML = `<table>${Object.entries(data).map(([k, v]) => k.startsWith('_') ? '' : `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
      
      const step = data.step || 'start';
      btnBox.innerHTML = '';
      const options = utteranceData["customer_change_mind"][step];
      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'action-btn'; btn.innerText = opt.label;
        btn.onclick = () => {
          const now = new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const msg = opt.text.replace("{{매장명}}", data["이름"] || "매장");
          navigator.clipboard.writeText(msg);
          data.history.push({ label: opt.label, time: now });
          data.step = opt.next;
          refreshUI();
        };
        btnBox.appendChild(btn);
      });

      const logBox = document.getElementById('log-container');
      logBox.innerHTML = data.history.map(h => `<div class="log-item"><div class="log-time">${h.time}</div><div class="log-label">${h.label}</div></div>`).join('');
      logBox.scrollTop = logBox.scrollHeight;
    } else {
      head.innerText = "연동 대기 중...";
      btnBox.innerHTML = "";
    }
  }

  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; refreshUI(); } }, 1000);
  document.getElementById('toggle-detail').onclick = () => document.getElementById('eoc-detail-view').classList.toggle('stealth');
  document.addEventListener('keydown', (e) => { if (e.altKey && e.code === 'KeyS') panel.classList.toggle('stealth'); });
  document.getElementById('pin-btn').onclick = () => panel.classList.toggle('hover-mode');
  refreshUI();
}