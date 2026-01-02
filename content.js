const isEOC = location.host.includes('coupang.net');
const isZD = location.host.includes('zendesk.com');

// [EOC] 모든 행(tr)의 텍스트를 태그 요소로 추출
if (isEOC) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-testid="zendesk_order_ticket_async"]');
    if (btn) {
      const tags = {};
      document.querySelectorAll('tr').forEach(tr => {
        if (tr.cells.length >= 2) {
          const key = tr.cells[0].innerText.trim();
          const val = tr.cells[1].innerText.trim().split('\n')[0];
          tags[key] = val;
        }
      });
      // 파생값 생성: ETA1 시간만 추출 및 경과 여부 계산
      const eta1Raw = tags["ETA 1"] || tags["ETA1 (배정지연)"] || "";
      const etaTime = eta1Raw.replace("최초시간 ", "").trim();
      tags["_ETA1_시각"] = etaTime;
      tags["_ETA1_경과여부"] = isTimePassed(etaTime) ? "경과" : "미경과";

      chrome.storage.local.set({ "transfer_buffer": { ...tags, _ts: Date.now() } });
    }
  });
}

function isTimePassed(t) {
  if(!t || !t.includes(':')) return false;
  const now = new Date();
  const [h, m] = t.split(':').map(Number);
  const target = new Date(); target.setHours(h, m, 0);
  return now > target;
}

// [Zendesk] 태그 치환 엔진 및 UI
if (isZD) {
  let ticketStore = {};
  let userSettings = { name: "" };
  let lastPath = location.pathname;

  const panel = document.createElement('div');
  panel.id = 'zd-helper-panel';
  panel.className = 'hover-mode';
  panel.innerHTML = `
    <div class="header">
      <span id="timer-display" style="color:blue; font-weight:bold; min-width:35px;">00:00</span>
      <span id="info-header">연동 대기 중...</span>
      <div><button id="pin-btn">📌</button><button id="stealth-btn">👻</button></div>
    </div>
    <div id="log-container"></div>
    <div id="eoc-detail-view" class="tab-view stealth"></div>
    <div id="settings-view" class="tab-view stealth">
      <label>상담사 이름</label><input id="set-name" type="text" style="width:100%">
      <button id="save-settings" style="width:100%; margin-top:5px; background:#32a1ce; color:white">저장</button>
    </div>
    <div id="btn-container"></div>
    <div class="footer"><button id="toggle-detail">EOC 정보</button><button id="toggle-settings">⚙️ 설정</button></div>
  `;
  document.body.appendChild(panel);

  // 모든 {{태그}}를 데이터로 치환하는 엔진
  function tagEngine(text, data, settings) {
    let result = text;
    // 1. 설정값 치환
    result = result.replace(/{{상담사명}}/g, settings.name || "상담사");
    // 2. EOC 원본 및 파생값 치환
    Object.entries(data).forEach(([key, val]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      result = result.replace(regex, val);
    });
    return result;
  }

  // 사용자님이 직접 작성할 발화 트리 예시
  const utteranceData = {
    "start": [
      { 
        label: "지연 안내(수동조합)", 
        text: "고객님 {{이름}} 주문건은 안내드린 {{_ETA1_시각}}이 {{_ETA1_경과여부}}된 상태입니다.", 
        next: "start" 
      }
    ]
  };

  function refreshUI() {
    const tid = location.pathname.match(/tickets\/(\d+)/)?.[1];
    if (!tid) return;
    if (!ticketStore[tid]) ticketStore[tid] = { step: 'start', history: [], eoc: {} };
    const data = ticketStore[tid];

    // 헤더 박제 정보 업데이트 (ID 뒷4자리, 축약번호, 스토어 이름)
    if (data.eoc["고유 주문 ID"]) {
      const fId = data.eoc["고유 주문 ID"];
      document.getElementById('info-header').innerText = `*${fId.slice(-4)} | ${data.eoc["축약형 주문 ID"]} | ${data.eoc["이름"]}`;
      document.getElementById('eoc-detail-view').innerHTML = `<table>${Object.entries(data.eoc).map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    }

    const btnBox = document.getElementById('btn-container');
    btnBox.innerHTML = '';
    utteranceData[data.step].forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'action-btn'; btn.innerText = opt.label;
      btn.onclick = () => {
        const finalMsg = tagEngine(opt.text, data.eoc, userSettings);
        navigator.clipboard.writeText(finalMsg);
        data.history.push({ label: opt.label, time: new Date().toLocaleTimeString('ko-KR', {hour12:false, hour:'2-digit', minute:'2-digit'}) });
        data.lastActionTime = Date.now();
        refreshUI();
      };
      btnBox.appendChild(btn);
    });
    document.getElementById('log-container').innerHTML = data.history.map(h => `<div style="border-left:2px solid #32a1ce; padding-left:3px"><span>${h.time}</span> <b>${h.label}</b></div>`).join('');
  }

  // 저장/감시 로직 (이전과 동일)
  chrome.storage.local.get("userSettings", r => { if(r.userSettings) { userSettings = r.userSettings; document.getElementById('set-name').value = userSettings.name; } });
  document.getElementById('save-settings').onclick = () => { userSettings.name = document.getElementById('set-name').value; chrome.storage.local.set({userSettings}); alert("저장됨"); refreshUI(); };
  document.getElementById('pin-btn').onclick = () => panel.classList.toggle('hover-mode');
  document.getElementById('stealth-btn').onclick = () => panel.classList.toggle('stealth');
  document.getElementById('toggle-detail').onclick = () => { document.getElementById('settings-view').classList.add('stealth'); document.getElementById('eoc-detail-view').classList.toggle('stealth'); };
  document.getElementById('toggle-settings').onclick = () => { document.getElementById('eoc-detail-view').classList.add('stealth'); document.getElementById('settings-view').classList.toggle('stealth'); };
  chrome.storage.onChanged.addListener(c => { if(c.transfer_buffer) { const tid = location.pathname.match(/tickets\/(\d+)/)?.[1]; if(tid) { ticketStore[tid].eoc = c.transfer_buffer.newValue; refreshUI(); } } });
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; refreshUI(); } }, 1000);
}