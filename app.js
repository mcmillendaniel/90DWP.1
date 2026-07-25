/**
 * 90DWP — entry point.
 *
 * A local-first PWA: state lives in localStorage, keyed by a logbook day that
 * starts at 4:00am local. Notifications are scheduled through a Cloudflare
 * Worker (see /worker) and delivered by web push.
 *
 * Modules:
 *   config.js      constants
 *   dom.js         $, toast, escapeHtml
 *   state.js       persistence, day keying, time formatting
 *   push.js        subscription, scheduling, diagnostics
 *   wake.js        wake modal + adaptive messaging
 *   timepicker.js  drum time editor
 *   views.js       HTML for each tab
 *   backup.js      export / import
 *   ui.js          render loop, wiring, action dispatch
 */
import { ensureDay, dayKey } from "./js/state.js";
import { render, startTicker } from "./js/ui.js";
import { registerServiceWorker, syncPushState } from "./js/push.js";

async function boot(){
  document.body.classList.remove("locked");
  ensureDay(dayKey());

  // Paint from local state first; nothing below blocks the first render.
  render();
  startTicker();

  try { await registerServiceWorker(); }
  catch(e){ console.error("[sw] registration failed:", e); }

  try { await syncPushState(); }
  catch(e){ console.error("[push] sync failed:", e); }

  // Re-render so Settings reflects the reconciled push state.
  render();
}

boot();
