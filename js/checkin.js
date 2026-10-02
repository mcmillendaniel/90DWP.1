/**
 * The daily morning check-in: a fixed-time push that sits on the lock screen
 * when the day starts, and opens straight onto the Morning tab when tapped.
 *
 * Queued the same way repeating reminders are (see reminders/schedule.js): the
 * Worker is a dumb one-shot queue, so the client queues the next few weeks of
 * mornings up front and tops the window up whenever the app is opened. Tags
 * are `checkin-YYYY-MM-DD`, and the Worker keys entries by tag, so re-queueing
 * a morning that is already queued overwrites it rather than doubling up.
 *
 * `settings.checkin.queuedThrough` records the last morning queued, so an
 * ordinary launch costs no Worker round-trips until the window runs low.
 */
import { schedulePush, cancelPushPrefix } from "./push.js";
import { state, saveState } from "./state.js";

export const CHECKIN_HOUR = 5;
export const CHECKIN_MINUTE = 0;
export const CHECKIN_TAG_PREFIX = "checkin-";

/** How many mornings ahead to hold in the queue. */
const DAYS_AHEAD = 21;
/** Top the queue up once fewer than this many mornings remain in it. */
const REFILL_BELOW_DAYS = 14;
/** Same reasoning as reminders: the cron sweeps once a minute. */
const MIN_LEAD_MS = 30 * 1000;

export const CHECKIN_TITLE = "Don't forget to Check In!";
export const CHECKIN_BODY = "Morning stack is waiting — tap to start checking things off.";

/** Fragment the app routes on; see openTabFromUrl in ui.js. */
export const CHECKIN_HASH = "#tab/morning";

function dateTag(d){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${CHECKIN_TAG_PREFIX}${y}-${m}-${day}`;
}

/**
 * The next `count` check-in instants after `now`, as { tag, sendAt }.
 *
 * Built with local setters and setDate(), never by adding 24h, so the push
 * stays at 5:00am wall-clock time across both DST changes.
 */
export function checkinTimes(now, count = DAYS_AHEAD){
  const out = [];
  const d = new Date(now);
  d.setHours(CHECKIN_HOUR, CHECKIN_MINUTE, 0, 0);
  if(d.getTime() < now + MIN_LEAD_MS) d.setDate(d.getDate() + 1);
  for(let i = 0; i < count; i++){
    out.push({ tag: dateTag(d), sendAt: d.getTime() });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export function checkinEnabled(){
  return state.settings.checkin.enabled;
}

/**
 * Brings the queued check-ins in line with the setting.
 *
 * Safe to call on every launch — it only reaches the Worker when the queued
 * window is running low, the setting changed, or `force` is set (after push is
 * re-enabled or data is imported, when the server queue cannot be trusted).
 * Returns how many pushes were queued.
 */
export async function reconcileCheckin(opts = {}){
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cfg = state.settings.checkin;

  if(!state.settings.pushEnabled){
    // Nothing reaches the device while push is off; forget what was queued so
    // enabling push again rebuilds the window.
    if(cfg.queuedThrough !== null){ cfg.queuedThrough = null; saveState(); }
    return 0;
  }

  if(!cfg.enabled){
    if(cfg.queuedThrough !== null || opts.force){
      await cancelPushPrefix(CHECKIN_TAG_PREFIX, { silent: true });
      cfg.queuedThrough = null;
      saveState();
    }
    return 0;
  }

  const times = checkinTimes(now);
  const refillAt = times[Math.min(REFILL_BELOW_DAYS, times.length) - 1].sendAt;
  if(!opts.force && cfg.queuedThrough !== null && cfg.queuedThrough >= refillAt) return 0;

  let queued = 0;
  for(const { tag, sendAt } of times){
    // Mornings already in the queue are left alone unless forced.
    if(!opts.force && cfg.queuedThrough !== null && sendAt <= cfg.queuedThrough) continue;
    const ok = await schedulePush(tag, CHECKIN_TITLE, CHECKIN_BODY, sendAt, {
      url: `${location.origin}${location.pathname}${CHECKIN_HASH}`,
      kind: "checkin"
    }, { silent: true });
    if(!ok) break;   // The Worker is unreachable; try again next launch.
    cfg.queuedThrough = sendAt;
    queued++;
  }
  saveState();
  return queued;
}

/** Flips the setting and applies it to the queue straight away. */
export async function setCheckinEnabled(enabled){
  state.settings.checkin.enabled = !!enabled;
  saveState();
  return reconcileCheckin({ force: true });
}
