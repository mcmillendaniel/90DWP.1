/**
 * Keeping the running app and the service worker on the same build.
 *
 * The worker is network-first with a 3s timeout, so a slow launch can serve a
 * cached copy of one file and a fresh copy of another. That produced a real
 * failure: a deploy that added a tab shipped a new index.html alongside a
 * cached js/ui.js with no view for it, and the tab silently rendered the wrong
 * screen. Nothing logged, nothing toasted — the exact failure mode this app has
 * been bitten by before.
 *
 * Two defences live here: reload once when a new worker takes over a page it
 * did not start with, and report both versions so a mismatch is visible in
 * Settings instead of guessed at.
 */

import { APP_VERSION } from "./config.js";

/** Bounded so a worker that re-activates repeatedly cannot loop the app. */
const RELOAD_COUNT_KEY = "90dwp_sw_reloads";
const MAX_RELOADS = 2;

let swCacheName = null;

export function getAppVersion(){ return APP_VERSION; }
export function getSwCacheName(){ return swCacheName; }

function reloadCount(){
  try { return Number(sessionStorage.getItem(RELOAD_COUNT_KEY)) || 0; }
  catch { return MAX_RELOADS; }   // no sessionStorage means no safety net
}

function noteReload(n){
  try { sessionStorage.setItem(RELOAD_COUNT_KEY, String(n)); } catch {}
}

/**
 * Must be called synchronously at boot, before registerServiceWorker(), so the
 * listener is attached before a waiting worker can claim the page.
 */
export function wireServiceWorkerUpdates(){
  if(!("serviceWorker" in navigator)) return;

  // Whether this page load was already under a worker. If it was not, this is a
  // first install and the controller change is expected — reloading there would
  // just be a pointless flash on someone's first launch.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if(!hadController || reloading) return;
    const n = reloadCount();
    if(n >= MAX_RELOADS){
      console.warn("[sw] new worker took over but the reload budget is spent");
      return;
    }
    reloading = true;
    noteReload(n + 1);
    console.warn("[sw] a new worker took over mid-session — reloading for a consistent build");
    location.reload();
  });
}

/**
 * Asks the controlling worker which cache it is serving from. Returns null when
 * there is no controller or it does not answer, which is itself worth showing.
 */
export function querySwCacheName(){
  const controller = navigator.serviceWorker?.controller;
  if(!controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if(!done){ done = true; swCacheName = value; resolve(value); } };
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => finish(event.data?.cache || null);
    // An old worker predating the GET_VERSION handler will never reply, and a
    // silent hang would be worse than an honest "unknown".
    setTimeout(() => finish(null), 1500);
    try { controller.postMessage({ type: "GET_VERSION" }, [channel.port2]); }
    catch(e){ console.error("[sw] version query failed:", e); finish(null); }
  });
}
