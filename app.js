/* 90DWP - MVP PWA (local storage + web push registration + scheduling via Worker) - Reset at 4:00am local - Tabs: home, checkoffs, morning, history, settings */
const WORKER_BASE_URL = "https://90dwp-push.mcmillendaniel.workers.dev";
const RESET_HOUR = 4; // 4:00am daily reset
const HARD_CUTOFF_HOUR = 17; // 5:00pm cutoff for work pushes
const CHECKIN_OFFSET_MIN = 1; // block 1/2 check-in offset
const BLOCK3_CHECKIN_OFFSET_MIN = 1; // block3 check-in after start

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

function dayKey(d = now()){
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
  if(raw){ try { return JSON.parse(raw); } catch {} }
  return { deviceId: safeUUID(), days: {}, settings: { pushEnabled: false } };
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
      morning: { movement: null, shower: null, outcomesWritten: null, meds: null },
      scheduled: { block1CheckinAt: null, block2CheckinAt: null, block3StartAt: null, block3CheckinAt: null, block3SnoozesUsed: 0 }
    };
  }
  return state.days[k];
}

let state = loadState();
saveState();
let currentTab = "home";

// FIX 4: Single service worker listener at top level only
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "NOTIF_ACTION") return;
    if (event.data.action === "snooze" && event.data.data?.kind === "b3_start") {
      handleSnoozeFromNotif(event.data.data);
    }
  });
}

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
  if(!WORKER_BASE_URL){ toast("Add Worker URL in app.js first."); return null; }
  const r = await fetch(`${WORKER_BASE_URL}/vapidPublicKey`);
  const { publicKey } = await r.json();
  const appServerKey = urlBase64ToUint8Array(publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing) { try { await existing.unsubscribe(); } catch {} }
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
  return sub;
}

async function sendSubscriptionToWorker(sub){
  const payload = { deviceId: state.deviceId, subscription: sub };
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
  let outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  // P-256 uncompressed public keys must be 65 bytes starting with 0x04
  // If key is 64 bytes, prepend the missing 0x04 uncompressed point prefix
  if (outputArray.length === 64) {
    const fixed = new Uint8Array(65);
    fixed[0] = 0x04;
    fixed.set(outputArray, 1);
    outputArray = fixed;
  }
  return outputArray;
}

async function enablePushFlow(){
  if(!WORKER_BASE_URL){ toast("Worker URL not set."); return; }
  let reg, sub;
  try {
    reg = await registerServiceWorker();
    console.log("[push] Step 1 SW reg OK:", reg);
  } catch(e) {
    console.error("[push] Step 1 SW reg failed:", e);
    toast("Push failed: SW reg — " + e.message); return;
  }
  try {
    const ok = await requestPushPermission();
    console.log("[push] Step 2 permission:", ok);
    if(!ok){ toast("Push permission not granted."); return; }
  } catch(e) {
    console.error("[push] Step 2 permission failed:", e);
    toast("Push failed: permission — " + e.message); return;
  }
  try {
    sub = await subscribeToPush(reg);
    console.log("[push] Step 3 subscribe OK:", sub);
  } catch(e) {
    console.error("[push] Step 3 subscribe failed:", e);
    toast("Push failed: subscribe — " + e.message); return;
  }
  try {
    await sendSubscriptionToWorker(sub);
    console.log("[push] Step 4 sent to worker OK");
  } catch(e) {
    console.error("[push] Step 4 send to worker failed:", e);
    toast("Push failed: worker — " + e.message); return;
  }
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
function isAfterCutoff(dateObj){ return dateObj.getHours() >= HARD_CUTOFF_HOUR; }

async function schedulePush(tag, title, body, sendAtMs, extra = {}){
  if(!state.settings.pushEnabled) return;
  if(!WORKER_BASE_URL) return;
  const when = new Date(sendAtMs);
  if(isAfterCutoff(when)) return;
  const payload = Object.assign({
    deviceId: state.deviceId, tag, title, body,
    sendAt: sendAtMs, url: location.origin + location.pathname
  }, (extra && typeof extra === "object") ? extra : {});
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
      <div class="small">Day resets at 4:00am • Work pushes stop after 5:00pm</div>
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
        Device ID: <b>${state.deviceId}</b>
      </div>
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

// ----- Modal-less prompt -----
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
  if(act === "export"){ exportData(); return; }
  if(act === "import"){ await importData(); return; }

  if(act.startsWith("event:")){
    const ev = act.split(":")[1];

    if (d.events[ev]) {
      const newTs = await window.openTimeEditFlow(d.events[ev]);
      if (newTs !== null) {
        d.events[ev] = newTs;
        if (ev === "babyUp") {
          const sendAt = newTs + CHECKIN_OFFSET_MIN * 60 * 1000;
          d.scheduled.block1CheckinAt = sendAt;
          await schedulePush(`b1-checkin-${dayKey()}`, "Block 1 check-in", "How's it going? What's the next tiny move?", sendAt, { kind: "b1_checkin" });
        }
        if (ev === "napStart") {
          const sendAt = newTs + CHECKIN_OFFSET_MIN * 60 * 1000;
          d.scheduled.block2CheckinAt = sendAt;
          await schedulePush(`b2-checkin-${dayKey()}`, "Block 2 check-in", "How's it going? What's the next tiny move?", sendAt, { kind: "b2_checkin" });
        }
        if (ev === "napEnd") {
          const delay = await promptBlock3Delay();
          if (delay != null) {
            const startAt = newTs + delay * 60 * 1000;
            const checkAt = startAt + BLOCK3_CHECKIN_OFFSET_MIN * 60 * 1000;
            d.scheduled.block3StartAt = startAt;
            d.scheduled.block3CheckinAt = checkAt;
            d.scheduled.block3SnoozesUsed = 0;
            await cancelScheduledByTagPrefix(`b3-`);
            await schedulePush(`b3-start-${dayKey()}`, "Block 3 starting", "Quick check: what's the one 10-minute win?", startAt, { kind: "b3_start", actions: [{ action: "snooze", title: "Snooze 10m" }] });
            await schedulePush(`b3-checkin-${dayKey()}`, "Block 3 check-in", "How's it going? Keep it small.", checkAt, { kind: "b3_checkin" });
          }
        }
        toast("Time updated.");
      }
      return;
    }

    const ts = Date.now();
    d.events[ev] = ts;

    // FIX 2: imUp wake modal — message/subtext now properly sourced
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

    // FIX 2: babyUp/napStart/napEnd now inside event: block where ev is defined
    if(ev === "babyUp"){
      const sendAt = ts + CHECKIN_OFFSET_MIN*60*1000;
      d.scheduled.block1CheckinAt = sendAt;
      await schedulePush(`b1-checkin-${dayKey()}`, "Block 1 check-in", "How's it going? What's the next tiny move?", sendAt, { kind:"b1_checkin" });
      toast("Baby up logged.");
      return;
    }

    if(ev === "napStart"){
      const sendAt = ts + CHECKIN_OFFSET_MIN*60*1000;
      d.scheduled.block2CheckinAt = sendAt;
      await schedulePush(`b2-checkin-${dayKey()}`, "Block 2 check-in", "How's it going? What's the next tiny move?", sendAt, { kind:"b2_checkin" });
      toast("Nap start logged.");
      return;
    }

    if(ev === "napEnd"){
      const delay = await promptBlock3Delay();
      if(delay == null){ toast("Canceled."); return; }
      const startAt = ts + delay*60*1000;
      const checkAt = startAt + BLOCK3_CHECKIN_OFFSET_MIN*60*1000;
      d.scheduled.block3StartAt = startAt;
      d.scheduled.block3CheckinAt = checkAt;
      d.scheduled.block3SnoozesUsed = 0;
      await cancelScheduledByTagPrefix(`b3-`);
      await schedulePush(`b3-start-${dayKey()}`, "Block 3 starting", "Quick check: what's the one 10-minute win?", startAt, { kind:"b3_start", actions: [{ action:"snooze", title:"Snooze 10m" }] });
      await schedulePush(`b3-checkin-${dayKey()}`, "Block 3 check-in", "How's it going? Keep it small.", checkAt, { kind:"b3_checkin" });
      toast(`Block 3 set for +${delay}m`);
      return;
    }

    toast("Logged.");
    return;
  } // end event:
} // end handleAction

// ----- Boot -----
(async function init(){
  document.body.classList.remove("locked");
  ensureDay(dayKey());
  try { await registerServiceWorker(); } catch (e) {}
  render();
})();

// FIX 4: No duplicate serviceWorker listener here — removed from this function
async function handleSnoozeFromNotif(data){
  const d = ensureDay(dayKey());
  if(data.kind !== "b3_start") return;
  if(d.scheduled.block3SnoozesUsed >= 2){ toast("No snoozes left."); return; }
  d.scheduled.block3SnoozesUsed += 1;
  const newAt = Date.now() + 10*60*1000;
  d.scheduled.block3StartAt = newAt;
  await cancelScheduledByTagPrefix(`b3-start-${dayKey()}`);
  await schedulePush(
    `b3-start-${dayKey()}`,
    "Block 3 starting",
    "Quick check: what's the one 10-minute win?",
    newAt,
    { kind:"b3_start", actions: [{ action:"snooze", title:"Snooze 10m" }] }
  );
  saveState();
  toast("Snoozed 10m.");
}

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
