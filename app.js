/* 90DWP - MVP PWA (local storage + web push registration + scheduling via Worker)
   - Reset at 4:00am local
   - Tabs: home, checkoffs, morning, history, settings
*/

const WORKER_BASE_URL = "https://90dwp-push.mcmillendaniel.workers.dev";

const RESET_HOUR = 4;                 // 4:00am daily reset
const HARD_CUTOFF_HOUR = 17;          // 5:00pm cutoff for work pushes
const CHECKIN_OFFSET_MIN = 45;        // block 1/2 check-in offset
const BLOCK3_CHECKIN_OFFSET_MIN = 30; // block3 check-in after start

const $ = (id) => document.getElementById(id);
function safeUUID(){
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ----- Wake Lock Modal + Motivation Messages -----

let wakeModalEl = null;

function ensureWakeModal(){
  if (wakeModalEl) return wakeModalEl;

  const wrap = document.createElement("div");
  wrap.className = "wake-modal";
  wrap.id = "wakeModal";
  wrap.innerHTML = `
    <div class="wake-card">
      <div class="wake-title">Wake confirmed.</div>
      <div class="wake-msg" id="wakeMsg">Stand up. Move your body.</div>
      <div class="wake-sub" id="wakeSub">Small wins first. No debating.</div>
      <button class="wake-btn" id="wakeBtn">Hell yeah, brother</button>
    </div>
  `;
  document.body.appendChild(wrap);
  wakeModalEl = wrap;
  return wakeModalEl;
}

function openWakeModal({ message, subtext, onDismiss }){
  ensureWakeModal();
  document.body.classList.add("locked");

  $("wakeMsg").textContent = message;
  $("wakeSub").textContent = subtext;

  wakeModalEl.classList.add("show");

  const btn = $("wakeBtn");
  btn.onclick = () => {
    wakeModalEl.classList.remove("show");
    document.body.classList.remove("locked");
    if (typeof onDismiss === "function") onDismiss();
  };
}

function getWakeStats(){
  // Returns: { streakDays, consistencyScore } based on last 7 days with imUp timestamps
  const keys = Object.keys(state.days).sort(); // ascending
  const last7 = keys.slice(-7);

  const wakeTimes = [];
  for (const k of last7) {
    const ts = state.days[k]?.events?.imUp;
    if (ts) {
      const d = new Date(ts);
      wakeTimes.push(d.getHours() * 60 + d.getMinutes()); // minutes since midnight
    }
  }

  // streak: consecutive days ending today where imUp exists
  let streak = 0;
  const today = dayKey();
  const sorted = Object.keys(state.days).sort().reverse(); // newest -> oldest
  for (const k of sorted) {
    if (!state.days[k]?.events?.imUp) break;
    streak += 1;
    // stop once we pass 14 for sanity
    if (streak >= 14) break;
    // also stop if we hit a gap day (missing day in store)
    // (We keep it simple: streak is “consecutive logged days available in state”.)
  }
function pickWakeMessage(){
  // If anything goes weird, never brick the app
  try {
    const { streakDays, consistencyScore } = (typeof getWakeStats === "function")
      ? getWakeStats()
      : { streakDays: 0, consistencyScore: 0 };

    const supportiveGate = (streakDays >= 7) || (streakDays >= 4 && consistencyScore >= 0.6);
    const mixedGate = (streakDays >= 3);

    const hype = [
      "Feet on floor. Stand up now. No negotiations.",
      "Up. Water. Move. We’re not thinking—just executing.",
      "Get vertical. Your day starts when you move.",
      "Stand up. One small win in the next 10 minutes. Go."
    ];

    const mixed = [
      "Alright—let’s move. Small wins first, momentum second.",
      "Up we go. One 10-minute action to start the chain.",
      "Stand up, breathe, move. Then we decide the first win."
    ];

    const dad = [
      "Up we go—quiet, steady, on purpose. One small win first.",
      "Good morning. Let’s secure the day with three simple outcomes.",
      "We’re building consistency. One step, then the next."
    ];

    const pool = supportiveGate ? dad : (mixedGate ? mixed : hype);

    // rotate daily by dayKey so it's different each day but stable for that day
    const seed = (typeof dayKey === "function" ? dayKey() : "0").split("-").join("");
    const idx = Number(seed) % pool.length;

    const message = pool[idx];
    const subtext = supportiveGate
      ? `Streak: ${streakDays} day(s). Consistency: ${(consistencyScore*100)|0}%`
      : mixedGate
        ? `Streak: ${streakDays} day(s). Keep it small and clean.`
        : `We start before we feel ready.`;

    return { message, subtext };
  } catch (e) {
    return { message: "Stand up. Move your body.", subtext: "Small wins first." };
  }
}

  // consistency: lower spread => higher score
  // We'll use a simple range (max-min) in minutes across last 7 wake logs.
  let consistencyScore = 0; // 0..1
  if (wakeTimes.length >= 3) {
    const min = Math.min(...wakeTimes);
    const max = Math.max(...wakeTimes);
    const range = max - min; // minutes
    // 0 mins range => 1.0; 90+ mins range => near 0
    consistencyScore = Math.max(0, Math.min(1, 1 - (range / 90)));
  }

  return { streakDays: streak, consistencyScore };
}

function pickWakeMessage(){
  const { streakDays, consistencyScore } = getWakeStats();

  // Tiering:
  // - Early: hype/aggressive
  // - Mid: mixed
  // - Solid + consistent: supportive
  const supportiveGate = (streakDays >= 7) || (streakDays >= 4 && consistencyScore >= 0.6);
  const mixedGate = (streakDays >= 3);

  const hype = [
    "Feet on floor. Stand up now. No negotiations.",
    "Up. Water. Move. We’re not thinking—just executing.",
    "Get vertical. Your day starts when you move.",
    "Stand up. One small win in the next 10 minutes. Go."
  ];

  const mixed = [
    "Alright—let’s move. Small wins first, momentum second.",
    "Up we go. One 10-minute action to start the chain.",
    "Stand up, breathe, move. Then we decide the first win."
  ];

  const dad = [
    "Up we go—quiet, steady, on purpose. One small win first.",
    "Good morning. Let’s secure the day with three simple outcomes.",
    "We’re building consistency. One step, then the next."
  ];

  const pool = supportiveGate ? dad : (mixedGate ? mixed : hype);

  // rotate daily by dayKey so you get variety but stable for that day
  const seed = dayKey().split("-").join("");
  const idx = Number(seed) % pool.length;

  const message = pool[idx];
  const subtext = supportiveGate
    ? `Streak: ${streakDays} day(s). Consistency: ${(consistencyScore*100)|0}%`
    : mixedGate
      ? `Streak: ${streakDays} day(s). Keep it small and clean.`
      : `We start before we feel ready.`;

  return { message, subtext };
}

function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1600);
}

function now(){ return new Date(); }

function dayKey(d = now()){
  // shift by RESET_HOUR so that "day" starts at 4am
  const shifted = new Date(d.getTime() - RESET_HOUR*60*60*1000);
  return shifted.toISOString().slice(0,10);
}

function fmtTime(ts){
  if(!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
}

function loadState(){
  const raw = localStorage.getItem("90dwp_state_v1");
  if(raw){
    try { return JSON.parse(raw); } catch {}
  }
  return {
deviceId: safeUUID(),
    days: {},
    settings: {
      pushEnabled: false
    }
  };
}

function saveState(){
  localStorage.setItem("90dwp_state_v1", JSON.stringify(state));
}

function ensureDay(k){
  if(!state.days[k]){
    state.days[k] = {
      createdAt: Date.now(),
      outcomes: ["","",""],
      outcomesDone: [false,false,false],
      events: {
        imUp: null,
        babyUp: null,
        napStart: null,
        napEnd: null
      },
      morning: {
        movement: null,
        shower: null,
        outcomesWritten: null,
        meds: null
      },
      scheduled: {
        block1CheckinAt: null,
        block2CheckinAt: null,
        block3StartAt: null,
        block3CheckinAt: null,
        block3SnoozesUsed: 0
      }
    };
  }
  return state.days[k];
}

let state = loadState();
saveState();

let currentTab = "home";

// ----- Push Registration -----

async function registerServiceWorker(){
  if(!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.register("./sw.js");
  return reg;
}

async function requestPushPermission(){
  if(!("Notification" in window)) return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

async function getPushSubscription(reg){
  const sub = await reg.pushManager.getSubscription();
  return sub;
}

async function subscribeToPush(reg){
  // We’ll get the VAPID public key from the Worker
  if(!WORKER_BASE_URL){
    toast("Add Worker URL in app.js first.");
    return null;
  }
  const r = await fetch(`${WORKER_BASE_URL}/vapidPublicKey`);
  const { publicKey } = await r.json();
  const appServerKey = urlBase64ToUint8Array(publicKey);

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: appServerKey
  });
  return sub;
}

async function sendSubscriptionToWorker(sub){
  const payload = {
    deviceId: state.deviceId,
    subscription: sub
  };
  const r = await fetch(`${WORKER_BASE_URL}/subscribe`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if(!r.ok) throw new Error("Subscribe failed");
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function enablePushFlow(){
  if(!WORKER_BASE_URL){
    toast("Worker URL not set.");
    return;
  }
  const reg = await registerServiceWorker();
  const ok = await requestPushPermission();
  if(!ok){
    toast("Push permission not granted.");
    return;
  }
  let sub = await getPushSubscription(reg);
  if(!sub){
    sub = await subscribeToPush(reg);
  }
  await sendSubscriptionToWorker(sub);
  state.settings.pushEnabled = true;
  saveState();
  toast("Push enabled ✅");
}

async function disablePushFlow(){
  const reg = await navigator.serviceWorker.getRegistration();
  if(reg){
    const sub = await reg.pushManager.getSubscription();
    if(sub) await sub.unsubscribe();
  }
  state.settings.pushEnabled = false;
  saveState();
  toast("Push disabled");
}

// ----- Scheduling helpers -----

function isAfterCutoff(dateObj){
  return dateObj.getHours() >= HARD_CUTOFF_HOUR;
}

async function schedulePush(tag, title, body, sendAtMs, extra = {}){
  if(!state.settings.pushEnabled) return;
  if(!WORKER_BASE_URL) return;

  const when = new Date(sendAtMs);
  if(isAfterCutoff(when)) return;

  const payload = {
    deviceId: state.deviceId,
    tag,
    title,
    body,
    sendAt: sendAtMs,
    url: "./index.html",
    ...extra
  };
  await fetch(`${WORKER_BASE_URL}/schedule`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
}

async function cancelScheduledByTagPrefix(prefix){
  if(!state.settings.pushEnabled) return;
  if(!WORKER_BASE_URL) return;
  await fetch(`${WORKER_BASE_URL}/cancelPrefix`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ deviceId: state.deviceId, prefix })
  });
}

// ----- UI rendering -----

function setActiveTab(tab){
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(b=>{
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  render();
}

function computeTicker(){
  const d = ensureDay(dayKey());
  const total = 3;
  const done = d.outcomesDone.filter(Boolean).length;

  // Indicator color
  const ind = $("tickerIndicator");
  if(done === 0) ind.style.background = "var(--red)";
  else if(done < total) ind.style.background = "var(--yellow)";
  else ind.style.background = "var(--green)";

  // Text: scrolling-ish by rotating content every few seconds (simple)
  const texts = d.outcomes.map((t,i)=> (t?.trim() ? `${i+1}) ${t}` : `${i+1}) [empty]`));
  return { done, total, texts };
}

let tickerIdx = 0;
setInterval(()=>{
  const { texts } = computeTicker();
  const el = $("tickerText");
  el.textContent = texts[tickerIdx % texts.length];
  tickerIdx++;
}, 3500);

function renderHome(){
  const k = dayKey();
  const d = ensureDay(k);

  return `
    <section class="card">
      <h2 class="h2">Today</h2>
      <div class="small">Day resets at 4:00am • Work pushes stop after 5:00pm</div>
    </section>

    <section class="card">
      <h2 class="h2">Events</h2>
      <div class="row">
        <button class="btn" data-action="event:imUp">I’m up</button>
        <button class="btn" data-action="event:babyUp">Baby up</button>
        <button class="btn" data-action="event:napStart">Nap start</button>
        <button class="btn" data-action="event:napEnd">Nap end</button>
      </div>
      <div class="small" style="margin-top:10px">
        I’m up: <b>${fmtTime(d.events.imUp)}</b> •
        Baby up: <b>${fmtTime(d.events.babyUp)}</b> •
        Nap start: <b>${fmtTime(d.events.napStart)}</b> •
        Nap end: <b>${fmtTime(d.events.napEnd)}</b>
      </div>
    </section>

    <section class="card">
      <h2 class="h2">Block reminders</h2>
      <div class="small">
        Block 1 check-in: <b>${fmtTime(d.scheduled.block1CheckinAt)}</b><br/>
        Block 2 check-in: <b>${fmtTime(d.scheduled.block2CheckinAt)}</b><br/>
        Block 3 start: <b>${fmtTime(d.scheduled.block3StartAt)}</b><br/>
        Block 3 check-in: <b>${fmtTime(d.scheduled.block3CheckinAt)}</b>
      </div>
    </section>
  `;
}

function renderCheckoffs(){
  const d = ensureDay(dayKey());
  const rows = d.outcomes.map((txt,i)=>{
    const checked = d.outcomesDone[i] ? "checked" : "";
    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">Outcome ${i+1}</div>
          <div class="item-sub">${txt?.trim() ? escapeHtml(txt) : "—"}</div>
        </div>
        <label class="pill">
          <input type="checkbox" data-action="toggleOutcome:${i}" ${checked} />
          Done
        </label>
      </div>
    `;
  }).join("");

  const suggestions = buildSuggestions();

  return `
    <section class="card">
      <h2 class="h2">Write your 3 Outcomes</h2>
      <div class="small">Keep each one under ~10 minutes.</div>
      <div class="list" style="margin-top:10px">
        ${[0,1,2].map(i=>`
          <textarea class="input" rows="2" placeholder="Outcome ${i+1}"
            data-action="editOutcome:${i}">${escapeHtml(d.outcomes[i] || "")}</textarea>
        `).join("")}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="saveOutcomes">Save outcomes</button>
        <button class="btn" data-action="applySuggestion">Quick add suggestion</button>
      </div>
      <div class="small" style="margin-top:10px">
        Suggestion: <b id="suggestionText">${escapeHtml(suggestions.current || "—")}</b>
      </div>
    </section>

    <section class="card">
      <h2 class="h2">Check off</h2>
      <div class="list">
        ${rows}
      </div>
    </section>
  `;
}

function renderMorning(){
  const d = ensureDay(dayKey());
  const entries = [
    ["movement","Movement complete", d.morning.movement],
    ["shower","Shower done", d.morning.shower],
    ["outcomesWritten","Outcomes written", d.morning.outcomesWritten],
    ["meds","Meds taken", d.morning.meds],
  ];

  return `
    <section class="card">
      <h2 class="h2">Morning Stack</h2>
      <div class="small">Buttons log a timestamp. One reminder only: use this tab for checkoffs.</div>
      <div class="list" style="margin-top:10px">
        ${entries.map(([key,label,ts])=>`
          <div class="item">
            <div class="item-left">
              <div class="item-title">${label}</div>
              <div class="item-sub">${fmtTime(ts)}</div>
            </div>
            <button class="btn" style="flex:0 0 auto" data-action="morning:${key}">Log</button>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderHistory(){
  const keys = Object.keys(state.days).sort().slice(-7).reverse();
  const cards = keys.map(k=>{
    const d = state.days[k];
    const done = (d.outcomesDone || []).filter(Boolean).length;
    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${k}</div>
          <div class="item-sub">Outcomes: ${done}/3 • I’m up: ${fmtTime(d.events?.imUp)} • Baby up: ${fmtTime(d.events?.babyUp)}</div>
        </div>
        <div class="pill">${done === 3 ? "✅" : done === 0 ? "—" : "…"}</div>
      </div>
    `;
  }).join("");

  return `
    <section class="card">
      <h2 class="h2">History (last 7 days)</h2>
      <div class="list">${cards || `<div class="small">No history yet.</div>`}</div>
    </section>
  `;
}

function renderSettings(){
  return `
    <section class="card">
      <h2 class="h2">Settings</h2>

      <div class="item">
        <div class="item-left">
          <div class="item-title">Push Notifications</div>
          <div class="item-sub">${state.settings.pushEnabled ? "Enabled" : "Disabled"} (iPhone PWA)</div>
        </div>
        ${
          state.settings.pushEnabled
            ? `<button class="btn" style="flex:0 0 auto" data-action="push:disable">Disable</button>`
            : `<button class="btn" style="flex:0 0 auto" data-action="push:enable">Enable</button>`
        }
      </div>

      <div class="item">
        <div class="item-left">
          <div class="item-title">Export</div>
          <div class="item-sub">Download JSON + CSV backup</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="export">Export</button>
      </div>

      <div class="item">
        <div class="item-left">
          <div class="item-title">Import</div>
          <div class="item-sub">Restore from JSON</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="import">Import</button>
      </div>

      <div class="small" style="margin-top:10px">
        Device ID: <b>${state.deviceId}</b>
      </div>
    </section>
  `;
}

function render(){
  computeTicker(); // update indicator
  const main = $("main");

  if(currentTab === "home") main.innerHTML = renderHome();
  else if(currentTab === "checkoffs") main.innerHTML = renderCheckoffs();
  else if(currentTab === "morning") main.innerHTML = renderMorning();
  else if(currentTab === "history") main.innerHTML = renderHistory();
  else if(currentTab === "settings") main.innerHTML = renderSettings();

  wireActions();
}

function wireActions(){
  document.querySelectorAll("[data-action]").forEach(el=>{
    const act = el.getAttribute("data-action");
    // textareas: input event
    if(el.tagName === "TEXTAREA"){
      el.oninput = () => {
        // no auto-save; we store in a draft field on day object
        const [_, idxStr] = act.split(":");
        const idx = Number(idxStr);
        const d = ensureDay(dayKey());
        d.outcomes[idx] = el.value;
        saveState();
      };
      return;
    }

    el.onclick = async () => {
      try {
        await handleAction(act, el);
        saveState();
        render();
      } catch (e){
        console.error(e);
        toast("Something went wrong.");
      }
    };
  });

  document.querySelectorAll(".tab").forEach(btn=>{
    btn.onclick = () => setActiveTab(btn.dataset.tab);
  });
}

function buildSuggestions(){
  // "Slightly smarter": look at most recent day with unfinished outcomes and propose first unfinished
  const keys = Object.keys(state.days).sort().reverse();
  for(const k of keys){
    const d = state.days[k];
    if(!d?.outcomes?.length) continue;
    const idx = (d.outcomesDone || []).findIndex(x=>!x);
    if(idx !== -1 && d.outcomes[idx]?.trim()){
      return { current: `Finish: ${d.outcomes[idx].trim()}` };
    }
  }
  return { current: "" };
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ----- Actions -----

async function handleAction(act){
  const d = ensureDay(dayKey());

  if(act === "saveOutcomes"){
    toast("Saved.");
    return;
  }

  if(act === "applySuggestion"){
    const sug = buildSuggestions().current;
    if(!sug){
      toast("No suggestion found.");
      return;
    }
    // Put suggestion into first empty outcome slot, else overwrite #3
    let idx = d.outcomes.findIndex(x=>!x?.trim());
    if(idx === -1) idx = 2;
    d.outcomes[idx] = sug;
    toast("Added suggestion.");
    return;
  }

  if(act.startsWith("toggleOutcome:")){
    const idx = Number(act.split(":")[1]);
    d.outcomesDone[idx] = !d.outcomesDone[idx];
    if(d.outcomesDone.every(Boolean)){
      // dopamine: subtle + tiny celebration text
      toast("Day secured ✅🔥");
      // optional push celebration (light)
      await schedulePush(
        `celebrate-${dayKey()}`,
        "90DWP",
        "Day secured. Nice work.",
        Date.now() + 1000
      );
    }
    return;
  }

  if(act.startsWith("morning:")){
    const key = act.split(":")[1];
    d.morning[key] = Date.now();

    // If they log outcomesWritten here, we do NOT auto-check outcomes — this is just stack tracking
    toast("Logged.");
    return;
  }

  if(act === "push:enable"){
    await enablePushFlow();
    return;
  }
  if(act === "push:disable"){
    await disablePushFlow();
    return;
  }

  if(act === "export"){
    exportData();
    return;
  }
  if(act === "import"){
    await importData();
    return;
  }

 if(act.startsWith("event:")){
  const ev = act.split(":")[1];

  // LOCK: prevent double-press for the day
  if (ev === "imUp" && d.events.imUp) {
    toast("Already logged I’m up for today.");
    return;
  }

  const ts = Date.now();
  d.events[ev] = ts;

  if(ev === "imUp"){
    const { message, subtext } = pickWakeMessage();

    // full lock modal, then route to Morning tab
    openWakeModal({
      message,
      subtext,
      onDismiss: () => {
        setActiveTab("morning");
        toast("Morning stack. Keep it small.");
      }
    });
    return;
  }

  if(ev === "babyUp"){
    // schedule block1 check-in only
    const sendAt = ts + CHECKIN_OFFSET_MIN*60*1000;
    d.scheduled.block1CheckinAt = sendAt;

    await schedulePush(
      `b1-checkin-${dayKey()}`,
      "Block 1 check-in",
      "How’s it going? What’s the next tiny move?",
      sendAt,
      { kind:"b1_checkin" }
    );
    toast("Baby up logged.");
    return;
  }

  if(ev === "napStart"){
    // schedule block2 check-in only
    const sendAt = ts + CHECKIN_OFFSET_MIN*60*1000;
    d.scheduled.block2CheckinAt = sendAt;

    await schedulePush(
      `b2-checkin-${dayKey()}`,
      "Block 2 check-in",
      "How’s it going? What’s the next tiny move?",
      sendAt,
      { kind:"b2_checkin" }
    );
    toast("Nap start logged.");
    return;
  }

  if(ev === "napEnd"){
    // prompt 30/40/45
    const delay = await promptBlock3Delay(); // minutes
    if(delay == null){
      toast("Canceled.");
      return;
    }

    const startAt = ts + delay*60*1000;
    const checkAt = startAt + BLOCK3_CHECKIN_OFFSET_MIN*60*1000;

    d.scheduled.block3StartAt = startAt;
    d.scheduled.block3CheckinAt = checkAt;
    d.scheduled.block3SnoozesUsed = 0;

    // Cancel any prior block3 scheduled pushes today
    await cancelScheduledByTagPrefix(`b3-`);

    await schedulePush(
      `b3-start-${dayKey()}`,
      "Block 3 starting",
      "Quick check: what’s the one 10-minute win?",
      startAt,
      {
        kind:"b3_start",
        actions: [
          { action:"snooze", title:"Snooze 10m" }
        ]
      }
    );

    await schedulePush(
      `b3-checkin-${dayKey()}`,
      "Block 3 check-in",
      "How’s it going? Keep it small.",
      checkAt,
      { kind:"b3_checkin" }
    );

    toast(`Block 3 set for +${delay}m`);
    return;
  }

  toast("Logged.");
  return;
} // end event:

} // end handleAction

// Modal-less prompt for MVP (simple)
function promptBlock3Delay(){
  return new Promise((resolve)=>{
    const choice = window.prompt("Block 3 delay after Nap End? Type 30, 40, or 45:", "40");
    if(choice == null) return resolve(null);
    const v = Number(choice);
    if([30,40,45].includes(v)) return resolve(v);
    resolve(40);
  });
}

// ----- Export/Import -----

function exportData(){
  const json = JSON.stringify(state, null, 2);
  downloadFile(`90dwp-backup-${Date.now()}.json`, json, "application/json");

  // CSV: just outcomes per day (simple)
  const rows = [["date","outcome1","done1","outcome2","done2","outcome3","done3","imUp","babyUp","napStart","napEnd"]];
  Object.keys(state.days).sort().forEach(k=>{
    const d = state.days[k];
    rows.push([
      k,
      d.outcomes?.[0] || "", d.outcomesDone?.[0] ? "1":"0",
      d.outcomes?.[1] || "", d.outcomesDone?.[1] ? "1":"0",
      d.outcomes?.[2] || "", d.outcomesDone?.[2] ? "1":"0",
      d.events?.imUp ? new Date(d.events.imUp).toISOString() : "",
      d.events?.babyUp ? new Date(d.events.babyUp).toISOString() : "",
      d.events?.napStart ? new Date(d.events.napStart).toISOString() : "",
      d.events?.napEnd ? new Date(d.events.napEnd).toISOString() : ""
    ]);
  });

  const csv = rows.map(r=>r.map(csvEscape).join(",")).join("\n");
  downloadFile(`90dwp-export-${Date.now()}.csv`, csv, "text/csv");
  toast("Exported.");
}

function csvEscape(x){
  const s = String(x ?? "");
  if(s.includes(",") || s.includes('"') || s.includes("\n")){
    return `"${s.replaceAll('"','""')}"`;
  }
  return s;
}

function downloadFile(filename, contents, mime){
  const blob = new Blob([contents], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importData(){
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = () => {
    const file = input.files?.[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const parsed = JSON.parse(reader.result);
        // preserve current deviceId unless file has one AND user wants it (keep simple: keep current)
        const currentDeviceId = state.deviceId;
        state = parsed;
        state.deviceId = currentDeviceId;
        saveState();
        toast("Imported ✅");
        render();
      }catch(e){
        toast("Import failed.");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ----- Boot -----

(async function init(){
  // SAFETY: never allow a stale lock to brick the app
  document.body.classList.remove("locked");

  ensureDay(dayKey());
try { await registerServiceWorker(); } catch (e) {}
  render();
})();


async function handleSnoozeFromNotif(data){
  const d = ensureDay(dayKey());

  // only for block3 start notification
  if(data.kind !== "b3_start") return;

  if(d.scheduled.block3SnoozesUsed >= 2){
    toast("No snoozes left.");
    return;
  }
  d.scheduled.block3SnoozesUsed += 1;

  const newAt = Date.now() + 10*60*1000;
  d.scheduled.block3StartAt = newAt;

  // reschedule: cancel existing b3-start + create a new one
  await cancelScheduledByTagPrefix(`b3-start-${dayKey()}`);

  await schedulePush(
    `b3-start-${dayKey()}`,
    "Block 3 starting",
    "Quick check: what’s the one 10-minute win?",
    newAt,
    {
      kind:"b3_start",
      actions: [
        { action:"snooze", title:"Snooze 10m" }
      ]
    }
  );

  toast("Snoozed 10m.");
}
