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
 *   uid.js         id generation
 *   state.js       persistence, day keying, time formatting
 *   push.js        subscription, scheduling, diagnostics
 *   wake.js        wake modal + adaptive messaging
 *   timepicker.js  drum time editor
 *   views.js       HTML for each tab
 *   backup.js      export / import
 *   ui.js          render loop, wiring, action dispatch
 *   reminders/     the Reminders tab — see reminders/model.js
 */
import { ensureDay, dayKey } from "./js/state.js";
import { render, startTicker, openReminderFromUrl } from "./js/ui.js";
import { registerServiceWorker, syncPushState } from "./js/push.js";
import { rollForwardRepeats } from "./js/reminders/model.js";
import { reconcileReminderPushes } from "./js/reminders/schedule.js";
import { wireServiceWorkerUpdates, querySwCacheName } from "./js/version.js";

/**
 * A notification tap either focuses an open window — in which case the service
 * worker posts the url back — or opens a new one at the notification's url.
 * Both paths land here.
 */
function wireNotificationRouting(){
  if(openReminderFromUrl(location.hash)){
    // Drop the fragment so a later reload does not reopen the same reminder.
    history.replaceState(null, "", location.pathname + location.search);
  }
  if(!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if(event.data?.type !== "NOTIF_ACTION") return;
    if(openReminderFromUrl(event.data.data?.url)) render();
  });
}

async function boot(){
  document.body.classList.remove("locked");

  // Attached before anything is awaited, so a worker waiting to take over
  // cannot claim the page before the listener exists.
  wireServiceWorkerUpdates();

  ensureDay(dayKey());

  // Repeating reminders whose occurrence went by while the app was closed show
  // their next one, not a stale date.
  rollForwardRepeats();

  // Paint from local state first; nothing below blocks the first render.
  render();
  startTicker();
  wireNotificationRouting();

  try { await registerServiceWorker(); }
  catch(e){ console.error("[sw] registration failed:", e); }

  try { await syncPushState(); }
  catch(e){ console.error("[push] sync failed:", e); }

  try { await querySwCacheName(); }
  catch(e){ console.error("[sw] version query failed:", e); }

  // Re-render so Settings reflects the reconciled push state and the build
  // the service worker is actually serving.
  render();

  // Tops up the queued notification window for repeating reminders, and picks
  // up anything edited on a launch that could not reach the Worker.
  try { await reconcileReminderPushes(); }
  catch(e){ console.error("[reminders] reconcile failed:", e); }
}

boot();
