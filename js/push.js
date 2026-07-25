/** Web push: registration, subscription, scheduling, and diagnostics. */
import { WORKER_BASE_URL, PUSH_RESULT_KEY } from "./config.js";
import { state, saveState } from "./state.js";
import { toast } from "./dom.js";

// Snapshot of everything that has to be true for web push to work at all.
// Surfaced in Settings so a failure is visible instead of guessed at.
export function pushEnvironment(){
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

export async function registerServiceWorker(){
  if(!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("./sw.js");
}

// Single place every Worker call goes through, so a non-2xx response can never
// pass silently. Throws with the status and body so the caller can toast it.
export async function postToWorker(path, body){
  let r;
  try {
    r = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch(e){
    throw new Error(`${path} unreachable — ${e.message}`);
  }
  const text = await r.text().catch(() => "");
  if(!r.ok) throw new Error(`${path} → HTTP ${r.status}${text ? ` ${text.slice(0, 120)}` : ""}`);
  return text;
}

function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for(let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
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

export async function enablePushFlow(){
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

export async function disablePushFlow(){
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

let lastSubEndpoint = null;
export function getLastSubEndpoint(){ return lastSubEndpoint; }

// pushEnabled lives in localStorage, which iOS can clear out from under us.
// The browser's own subscription is the real source of truth, so reconcile
// against it on boot rather than trusting a stale flag.
export async function syncPushState(){
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

// Returns true/false rather than throwing, so a scheduling failure surfaces as
// a specific toast instead of being swallowed by the generic action handler.
// Never fails silently.
export async function schedulePush(tag, title, body, sendAtMs, extra = {}){
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

// ----- Diagnostics -----

// A toast disappears in 1.6s, which is not long enough to read an HTTP error on
// a phone, and iOS has no reachable console. Persist the last result so it can
// be read in Settings at leisure and survive a reload.
let lastPushResult = null;

function setPushResult(ok, message){
  lastPushResult = { ok, message: String(message), at: Date.now() };
  try { localStorage.setItem(PUSH_RESULT_KEY, JSON.stringify(lastPushResult)); } catch {}
}

export function getPushResult(){
  if(lastPushResult) return lastPushResult;
  try { return JSON.parse(localStorage.getItem(PUSH_RESULT_KEY) || "null"); } catch { return null; }
}

// Bypasses the Worker entirely. Proves permission + service worker + OS-level
// display are all working, which isolates client problems from server ones.
export async function testLocalNotification(){
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
export async function testPushRoundTrip(){
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
    setPushResult(true, `HTTP 2xx accepted. Worker replied: ${res ? res.slice(0, 200) : "(empty body)"}`);
    toast("Worker accepted ✅ — expect it in ~15s");
  } catch(e){
    console.error("[push] test round trip failed:", e);
    setPushResult(false, e.message);
    toast(e.message);
  }
}
