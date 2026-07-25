/* 90DWP - MVP PWA (local storage + web push registration + scheduling via Worker) - Reset at 4:00am local - Tabs: home, checkoffs, morning, history, settings */
const WORKER_BASE_URL = "https://90dwp-push.mcmillendaniel.workers.dev";
const RESET_HOUR = 4; // 4:00am daily reset

const $ = (id) => document.getElementById(id);

function safeUUID(){
  if (crypto && typeof crypto.randomUUID === "function") { return crypto.randomUUID(); }
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

// FIX 1: getWakeStats closes properly — pickWakeMessage nested copy removed
function getWakeStats(){
  const keys = Object.keys(state.days).sort();
  const last7 = keys.slice(-7);
  const wakeTimes = [];
  for (const k of last7) {
    const ts = state.days[k]?.events?.imUp;
    if (ts) {
      const d = new Date(ts);
      wakeTimes.push(d.getHours() * 60 + d.getMinutes());
    }
  }
  let streak = 0;
  const sorted = Object.keys(state.days).sort().reverse();
  for (const k of sorted) {
    if (!state.days[k]?.events?.imUp) break;
    streak += 1;
    if (streak >= 14) break;
  }
  let consistencyScore = 0;
  if (wakeTimes.length >= 3) {
    const min = Math.min(...wakeTimes);
    const max = Math.max(...wakeTimes);
    const range = max - min;
    consistencyScore = Math.max(0, Math.min(1, 1 - (range / 90)));
  }
  return { streakDays: streak, consistencyScore };
}

// FIX 1: Single top-level pickWakeMessage only
function pickWakeMessage(){
  try {
    const { streakDays, consistencyScore } = getWakeStats();
    const supportiveGate = (streakDays >= 7) || (streakDays >= 4 && consistencyScore >= 0.6);
    const mixedGate = (streakDays >= 3);
    const hype = [
      "Feet on floor. Stand up now. No negotiations.",
      "Up. Water. Move. We're not thinking—just executing.",
      "Get vertical. Your day starts when you move.",
      "Stand up. One small win in the next 10 minutes. Go."
    ];
    const mixed = [
      "Alright—let's move. Small wins first, momentum second.",
      "Up we go. One 10-minute action to start the chain.",
      "Stand up, breathe, move. Then we decide the first win."
    ];
    const dad = [
      "Up we go—quiet, steady, on purpose. One small win first.",
      "Good morning. Let's secure the day with three simple outcomes.",
      "We're building consistency. One step, then the next."
    ];
    const pool = supportiveGate ? dad : (mixedGate ? mixed : hype);
    const seed = dayKey().split("-").join("");
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

function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1600);
}

function now(){ return new Date(); }

// The logbook day starts at RESET_HOUR local time, so anything logged between
// midnight and 4am belongs to the previous calendar day.
//
// Reading the local wall-clock hour and stepping the calendar date back is
// correct in every timezone and across both DST transitions. The previous
// version subtracted 4 hours and then read the date via toISOString(), which
// is UTC — so the rollover landed at 4am only at UTC+0. In US Eastern it fired
// at midnight in summer and 11pm in winter, moving with DST twice a year.
function dayKey(d = now()){
  const local = new Date(d.getTime());
  if(local.getHours() < RESET_HOUR) local.setDate(local.getDate() - 1);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(ts){
  if(!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
}

const DEFAULT_SETTINGS = { pushEnabled: false };

// Guarantees deviceId/days/settings always exist, so nothing downstream can
// crash on a partial or hand-edited state blob.
function normalizeState(raw){
  const base = (raw && typeof raw === "object") ? raw : {};
  return {
    deviceId: base.deviceId || safeUUID(),
    days: (base.days && typeof base.days === "object") ? base.days : {},
    settings: Object.assign({}, DEFAULT_SETTINGS, base.settings || {})
  };
}

function loadState(){
  const raw = localStorage.getItem("90dwp_state_v1");
  let parsed = null;
  if(raw){ try { parsed = JSON.parse(raw); } catch {} }
  return normalizeState(parsed);
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
      events: { imUp: null, babyUp: null, napStart: null, napEnd: null },
      morning: { movement: null, shower: null, outcomesWritten: null, meds: null }
    };
  }
  return state.days[k];
}

let state = loadState();
saveState();
let currentTab = "home";


// ----- Push Registration -----

// Snapshot of everything that has to be true for web push to work at all.
// Surfaced in Settings so a failure is visible instead of guessed at.
function pushEnvironment(){
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  return {
    isIOS,
    isStandalone,
    hasSW: "serviceWorker" in navigator,
    hasPush: "PushManager" in window,
    hasNotification: "Notification" in window,
    permission: ("Notification" in window) ? Notification.permission : "unsupported"
  };
}

async function registerServiceWorker(){
  if(!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("./sw.js");
}

// Single place every Worker call goes through, so a non-2xx response can never
// pass silently again. Throws with the status and body so the caller can toast it.
async function postToWorker(path, body){
  let r;
  try {
    r = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
  } catch(e){
    throw new Error(`${path} unreachable — ${e.message}`);
  }
  const text = await r.text().catch(()=> "");
  if(!r.ok) throw new Error(`${path} → HTTP ${r.status}${text ? ` ${text.slice(0,120)}` : ""}`);
  return text;
}

async function subscribeToPush(reg){
  const r = await fetch(`${WORKER_BASE_URL}/vapidPublicKey`);
  if(!r.ok) throw new Error(`/vapidPublicKey → HTTP ${r.status}`);
  const { publicKey } = await r.json();
  if(!publicKey) throw new Error("Worker returned no publicKey");
  const appServerKey = urlBase64ToUint8Array(publicKey);
  // Drop any subscription bound to a previous VAPID key — those are dead on
  // arrival at the push service and can never be revived.
  const existing = await reg.pushManager.getSubscription();
  if(existing){ try { await existing.unsubscribe(); } catch {} }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
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
  const env = pushEnvironment();

  if(env.isIOS && !env.isStandalone){
    toast("iOS: Share → Add to Home Screen, then open from the icon.");
    return;
  }
  if(!env.hasSW || !env.hasPush || !env.hasNotification){
    toast("This browser can't do web push here.");
    return;
  }

  // Must be called synchronously inside the click handler. WebKit only honors
  // requestPermission() while the user gesture is still active, so awaiting
  // anything before this line (SW registration, a fetch) silently kills it.
  const permissionPromise = Notification.requestPermission();

  try {
    const perm = await permissionPromise;
    console.log("[push] permission:", perm);
    if(perm !== "granted"){ toast(`Notification permission: ${perm}.`); return; }
  } catch(e){
    console.error("[push] permission failed:", e);
    toast("Permission request failed — " + e.message); return;
  }

  let reg, sub;
  try {
    reg = await registerServiceWorker();
    await navigator.serviceWorker.ready;
    console.log("[push] SW ready:", reg);
  } catch(e){
    console.error("[push] SW registration failed:", e);
    toast("Service worker failed — " + e.message); return;
  }

  try {
    sub = await subscribeToPush(reg);
    console.log("[push] subscribed:", sub && sub.endpoint);
  } catch(e){
    console.error("[push] subscribe failed:", e);
    toast("Subscribe failed — " + e.message); return;
  }

  try {
    await postToWorker("/subscribe", { deviceId: state.deviceId, subscription: sub });
    console.log("[push] subscription stored on worker");
  } catch(e){
    console.error("[push] worker /subscribe failed:", e);
    toast("Worker rejected subscription — " + e.message); return;
  }

  state.settings.pushEnabled = true;
  saveState();
  toast("Push enabled ✅");
}

async function disablePushFlow(){
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if(reg){
      const sub = await reg.pushManager.getSubscription();
      if(sub) await sub.unsubscribe();
    }
  } catch(e){
    console.error("[push] unsubscribe failed:", e);
  }
  state.settings.pushEnabled = false;
  saveState();
  toast("Push disabled");
}

// pushEnabled lives in localStorage, which iOS can clear out from under us.
// The browser's own subscription is the real source of truth, so reconcile
// against it on boot rather than trusting a stale flag.
async function syncPushState(){
  const env = pushEnvironment();
  if(!env.hasSW || !env.hasPush || !env.hasNotification) return;
  let live = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if(reg){
      const sub = await reg.pushManager.getSubscription();
      live = !!sub && Notification.permission === "granted";
      // Which push service this device is bound to (Apple vs Google) is worth
      // seeing — it confirms a real subscription exists right now, client-side.
      if(sub){ try { lastSubEndpoint = new URL(sub.endpoint).host; } catch {} }
    }
  } catch(e){
    console.error("[push] state sync failed:", e);
    return;
  }
  if(state.settings.pushEnabled !== live){
    console.warn(`[push] correcting pushEnabled: ${state.settings.pushEnabled} → ${live}`);
    state.settings.pushEnabled = live;
    saveState();
  }
}

// ----- Diagnostics -----

// A toast disappears in 1.6s, which is not long enough to read an HTTP error on
// a phone, and iOS has no reachable console. Persist the last result so it can
// be read in Settings at leisure and survive a reload.
let lastPushResult = null;
let lastSubEndpoint = null;

function setPushResult(ok, message){
  lastPushResult = { ok, message: String(message), at: Date.now() };
  try { localStorage.setItem("90dwp_last_push_result", JSON.stringify(lastPushResult)); } catch {}
}

function getPushResult(){
  if(lastPushResult) return lastPushResult;
  try { return JSON.parse(localStorage.getItem("90dwp_last_push_result") || "null"); } catch { return null; }
}

// Bypasses the Worker entirely. Proves permission + service worker + OS-level
// display are all working, which isolates client problems from server ones.
async function testLocalNotification(){
  const env = pushEnvironment();
  if(env.isIOS && !env.isStandalone){ toast("iOS: open from the Home Screen icon."); return; }
  if(!env.hasNotification){ toast("Notifications unsupported here."); return; }
  if(Notification.permission !== "granted"){ toast(`Permission is "${Notification.permission}" — tap Enable.`); return; }
  const reg = await navigator.serviceWorker.getRegistration();
  if(!reg){ toast("No service worker registered."); return; }
  await reg.showNotification("90DWP test", {
    body: "Local notification. Display works.",
    tag: "90dwp-test-local",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png"
  });
  toast("Local notification fired.");
}

// Deliberately ignores the pushEnabled gate so it always hits the network and
// reports the real status code — that is the whole point of the button.
async function testPushRoundTrip(){
  const sendAt = Date.now() + 15000;
  toast("Contacting worker…");
  try {
    const res = await postToWorker("/schedule", {
      deviceId: state.deviceId,
      tag: `test-${Date.now()}`,
      title: "90DWP test push",
      body: "Round trip works.",
      sendAt,
      url: location.origin + location.pathname
    });
    console.log("[push] test scheduled, worker said:", res || "(empty body)");
    // A 200 with a strange body still tells us something, so keep the reply.
    setPushResult(true, `HTTP 2xx accepted. Worker replied: ${res ? res.slice(0,200) : "(empty body)"}`);
    toast("Worker accepted ✅ — expect it in ~15s");
  } catch(e){
    console.error("[push] test round trip failed:", e);
    setPushResult(false, e.message);
    toast(e.message);
  }
}

// ----- Scheduling helpers -----
// Returns true/false rather than throwing, so a scheduling failure surfaces as
// a specific toast instead of being swallowed by the generic handler in
// wireActions(). Never fails silently.
async function schedulePush(tag, title, body, sendAtMs, extra = {}){
  if(!state.settings.pushEnabled){
    console.warn("[push] not scheduled, push disabled:", tag);
    toast("Push is off — enable it in Settings.");
    return false;
  }
  const payload = Object.assign({
    deviceId: state.deviceId, tag, title, body,
    sendAt: sendAtMs, url: location.origin + location.pathname
  }, (extra && typeof extra === "object") ? extra : {});
  try {
    await postToWorker("/schedule", payload);
    console.log(`[push] scheduled ${tag} for ${new Date(sendAtMs).toLocaleTimeString()}`);
    return true;
  } catch(e){
    console.error("[push] schedule failed:", tag, e);
    toast("Schedule failed — " + e.message);
    return false;
  }
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
  const ind = $("tickerIndicator");
  if(done === 0) ind.style.background = "var(--red)";
  else if(done < total) ind.style.background = "var(--yellow)";
  else ind.style.background = "var(--green)";
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
      <div class="small">Day resets at 4:00am</div>
    </section>
    <section class="card">
      <h2 class="h2">Events</h2>
      <div class="row">
        <button class="btn" data-action="event:imUp">I'm up</button>
        <button class="btn" data-action="event:babyUp">Baby up</button>
        <button class="btn" data-action="event:napStart">Nap start</button>
        <button class="btn" data-action="event:napEnd">Nap end</button>
      </div>
      <div class="small" style="margin-top:10px">
        I'm up: <b>${fmtTime(d.events.imUp)}</b> •
        Baby up: <b>${fmtTime(d.events.babyUp)}</b> •
        Nap start: <b>${fmtTime(d.events.napStart)}</b> •
        Nap end: <b>${fmtTime(d.events.napEnd)}</b>
      </div>
      <div class="small" style="margin-top:8px">Tap a logged event again to edit its time.</div>
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
          <input type="checkbox" data-action="toggleOutcome:${i}" ${checked} /> Done
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
          <textarea class="input" rows="2" placeholder="Outcome ${i+1}" data-action="editOutcome:${i}">${escapeHtml(d.outcomes[i] || "")}</textarea>
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
      <div class="list">${rows}</div>
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
      <div class="small">Buttons log a timestamp. Tap a logged item again to edit its time.</div>
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
          <div class="item-sub">Outcomes: ${done}/3 • I'm up: ${fmtTime(d.events?.imUp)} • Baby up: ${fmtTime(d.events?.babyUp)}</div>
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
  const env = pushEnvironment();
  const yn = (v) => v ? "yes" : "no";
  const diagnostics = [
    ["Installed to Home Screen", yn(env.isStandalone)],
    ["Notification permission", env.permission],
    ["Push API available", yn(env.hasPush)],
    ["Service worker support", yn(env.hasSW)],
    ["Push endpoint", lastSubEndpoint || "none"]
  ];
  const result = getPushResult();
  const resultBlock = result
    ? `<div class="diag-result ${result.ok ? "diag-result--ok" : "diag-result--bad"}">
         <div class="item-title">Last test: ${result.ok ? "accepted" : "failed"} @ ${fmtTime(result.at)}</div>
         <div class="diag-result-msg">${escapeHtml(result.message)}</div>
       </div>`
    : "";
  const iosWarning = (env.isIOS && !env.isStandalone)
    ? `<div class="small" style="margin-top:10px;color:var(--red);font-weight:700">
         iOS requires this app to be added to the Home Screen and opened from
         that icon. Push cannot work in a Safari tab.
       </div>`
    : "";
  return `
    <section class="card">
      <h2 class="h2">Settings</h2>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Push Notifications</div>
          <div class="item-sub">${state.settings.pushEnabled ? "Enabled" : "Disabled"} (iPhone PWA)</div>
        </div>
        ${state.settings.pushEnabled
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
        Device ID: <b>${escapeHtml(state.deviceId)}</b>
      </div>
    </section>
    <section class="card">
      <h2 class="h2">Notification diagnostics</h2>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Test local notification</div>
          <div class="item-sub">Skips the server. Checks permission + display.</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="test:local">Run</button>
      </div>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Test push round trip</div>
          <div class="item-sub">Asks the worker to send one in ~15s.</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="test:push">Run</button>
      </div>
      <div class="list" style="margin-top:10px">
        ${diagnostics.map(([label, value])=>`
          <div class="item">
            <div class="item-left"><div class="item-title">${label}</div></div>
            <div class="pill">${escapeHtml(value)}</div>
          </div>
        `).join("")}
      </div>
      ${resultBlock}
      ${iosWarning}
    </section>
  `;
}

function render(){
  computeTicker();
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
    if(el.tagName === "TEXTAREA"){
      el.oninput = () => {
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

// ----- Export/Import -----
function exportData(){
  const json = JSON.stringify(state, null, 2);
  downloadFile(`90dwp-backup-${Date.now()}.json`, json, "application/json");
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
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click(); a.remove();
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
        const currentDeviceId = state.deviceId;
        state = normalizeState(parsed);
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

// ----- Actions -----
// FIX 2 & 3: handleAction is self-contained; ev blocks are inside event: branch
async function handleAction(act){
  const d = ensureDay(dayKey());

  if(act === "saveOutcomes"){ toast("Saved."); return; }

  if(act === "applySuggestion"){
    const sug = buildSuggestions().current;
    if(!sug){ toast("No suggestion found."); return; }
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
      toast("Day secured ✅🔥");
      await schedulePush(`celebrate-${dayKey()}`, "90DWP", "Day secured. Nice work.", Date.now() + 1000);
    }
    return;
  }

  if(act.startsWith("morning:")){
    const key = act.split(":")[1];
    if (d.morning[key]) {
      const newTs = await window.openTimeEditFlow(d.morning[key]);
      if (newTs !== null) {
        d.morning[key] = newTs;
        toast("Time updated.");
      }
      return;
    }
    d.morning[key] = Date.now();
    toast("Logged.");
    return;
  }

  if(act === "push:enable"){ await enablePushFlow(); return; }
  if(act === "push:disable"){ await disablePushFlow(); return; }
  if(act === "test:local"){ await testLocalNotification(); return; }
  if(act === "test:push"){ await testPushRoundTrip(); return; }
  if(act === "export"){ exportData(); return; }
  if(act === "import"){ await importData(); return; }

  if(act.startsWith("event:")){
    const ev = act.split(":")[1];

    // Tapping an already-logged event opens the time picker instead of
    // overwriting the timestamp.
    if(d.events[ev]){
      const newTs = await window.openTimeEditFlow(d.events[ev]);
      if(newTs !== null){
        d.events[ev] = newTs;
        toast("Time updated.");
      }
      return;
    }

    d.events[ev] = Date.now();

    if(ev === "imUp"){
      const { message, subtext } = pickWakeMessage();
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

    toast("Logged.");
    return;
  }
}

// ----- Boot -----
(async function init(){
  document.body.classList.remove("locked");
  ensureDay(dayKey());
  render();
  try { await registerServiceWorker(); } catch(e){ console.error("[sw] registration failed:", e); }
  try { await syncPushState(); } catch(e){ console.error("[push] sync failed:", e); }
  render();
})();

// ══════════════════════════════════════════════════════════════
// TIME EDIT FEATURE
// ══════════════════════════════════════════════════════════════

(function timeEditFeature() {

  function buildDrumItems(values) {
    const frag = document.createDocumentFragment();
    values.forEach(v => {
      const el = document.createElement("div");
      el.className = "te-drum-item";
      el.textContent = v;
      frag.appendChild(el);
    });
    return frag;
  }

  function initDrum(drumEl, values, startIndex) {
    drumEl.innerHTML = "";
    values.forEach(v => {
      const el = document.createElement("div");
      el.className = "te-drum-item";
      el.textContent = v;
      drumEl.appendChild(el);
    });

    const ITEM_H = 44;
    const VISIBLE_ITEMS = 3; // items shown in the 160px window (44*3 = 132, close enough)
    const PAD_PX = (160 - ITEM_H) / 2; // center the selected item in the 160px column

    drumEl.style.paddingTop    = PAD_PX + "px";
    drumEl.style.paddingBottom = PAD_PX + "px";

    let currentIdx = startIndex;
    let startY = 0, startOffset = 0;
    let offset = startIndex * ITEM_H;

    function clamp(v) { return Math.max(0, Math.min((values.length - 1) * ITEM_H, v)); }

    function applyOffset(o, animate) {
      drumEl.style.transition = animate ? "transform .15s ease" : "none";
      drumEl.style.transform  = `translateY(${-o}px)`;
    }

    function snapTo(idx) {
      currentIdx = Math.round(Math.max(0, Math.min(values.length - 1, idx)));
      offset = currentIdx * ITEM_H;
      applyOffset(offset, true);
    }

    applyOffset(offset, false);

    drumEl.addEventListener("touchstart", e => {
      startY = e.touches[0].clientY;
      startOffset = offset;
      drumEl.style.transition = "none";
    }, { passive: true });

    drumEl.addEventListener("touchmove", e => {
      e.preventDefault();
      const dy = startY - e.touches[0].clientY;
      offset = clamp(startOffset + dy);
      applyOffset(offset, false);
    }, { passive: false });

    drumEl.addEventListener("touchend", () => {
      snapTo(Math.round(offset / ITEM_H));
    });

    drumEl.addEventListener("mousedown", e => {
      startY = e.clientY;
      startOffset = offset;
      drumEl.style.transition = "none";
      const onMove = ev => {
        const dy = startY - ev.clientY;
        offset = clamp(startOffset + dy);
        applyOffset(offset, false);
      };
      const onUp = () => {
        snapTo(Math.round(offset / ITEM_H));
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    return {
      getValue: () => values[currentIdx],
      getIndex: () => currentIdx,
      snapTo
    };
  }

  function openOverlay(id) {
    const el = document.getElementById(id);
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
  }
  function closeOverlay(id) {
    const el = document.getElementById(id);
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }

  function openTimeEditFlow(existingTs) {
    return new Promise(resolve => {

      // Step 1: confirm
      const sub = document.getElementById("editConfirmSub");
      const existing = new Date(existingTs);
      sub.textContent = `Currently logged: ${existing.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      openOverlay("editConfirmModal");

      const onCancel = () => { closeOverlay("editConfirmModal"); cleanup1(); resolve(null); };
      const onYes    = () => { closeOverlay("editConfirmModal"); cleanup1(); openPicker(); };

      document.getElementById("editConfirmCancel").addEventListener("click", onCancel);
      document.getElementById("editConfirmYes").addEventListener("click", onYes);

      function cleanup1() {
        document.getElementById("editConfirmCancel").removeEventListener("click", onCancel);
        document.getElementById("editConfirmYes").removeEventListener("click", onYes);
      }

      // Step 2: picker
      function openPicker() {
        const HOURS   = ["1","2","3","4","5","6","7","8","9","10","11","12"];
        const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
        const AMPM    = ["AM","PM"];

        let h = existing.getHours();
        const ampmIdx = h >= 12 ? 1 : 0;
        h = h % 12 || 12;
        const hourIdx = HOURS.indexOf(String(h));
        const minIdx  = existing.getMinutes();

        const dHour = initDrum(document.getElementById("drumHour"),  HOURS,   hourIdx < 0 ? 0 : hourIdx);
        const dMin  = initDrum(document.getElementById("drumMin"),   MINUTES, minIdx);
        const dAmPm = initDrum(document.getElementById("drumAmPm"),  AMPM,    ampmIdx);

        openOverlay("editPickerModal");

        const onPickerCancel  = () => { closeOverlay("editPickerModal"); cleanup2(); resolve(null); };
        const onPickerConfirm = () => {
          closeOverlay("editPickerModal");
          cleanup2();

          let hours24 = parseInt(dHour.getValue(), 10);
          const mins  = parseInt(dMin.getValue(),  10);
          const ap    = dAmPm.getValue();
          if (ap === "AM" && hours24 === 12) hours24 = 0;
          if (ap === "PM" && hours24 !== 12) hours24 += 12;

          const base = new Date(existingTs);
          base.setHours(hours24, mins, 0, 0);
          resolve(base.getTime());
        };

        document.getElementById("editPickerCancel").addEventListener("click", onPickerCancel);
        document.getElementById("editPickerConfirm").addEventListener("click", onPickerConfirm);

        function cleanup2() {
          document.getElementById("editPickerCancel").removeEventListener("click", onPickerCancel);
          document.getElementById("editPickerConfirm").removeEventListener("click", onPickerConfirm);
        }
      }
    });
  }

  window.openTimeEditFlow = openTimeEditFlow;

})();
