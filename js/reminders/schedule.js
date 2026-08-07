/**
 * Turns reminders into queued web-push notifications.
 *
 * ## Why the expansion happens here
 *
 * The Cloudflare Worker is a dumb queue: one KV entry per notification, swept
 * once a minute, deleted after sending. It knows nothing about repeat rules.
 * Rather than teach it recurrence — which would mean a second implementation of
 * the date arithmetic in recur.js, in TypeScript, running in a runtime with no
 * reachable logs — the client expands a repeating reminder into its next N
 * occurrences and queues them all. The window is re-topped-up every time the
 * app opens.
 *
 * The trade-off is stated plainly: a repeating reminder is only guaranteed to
 * keep firing for as long as the queued window covers, and the app has to be
 * opened within that window to extend it. For a daily reminder that is about
 * three weeks. Non-repeating reminders are queued as a single push and are
 * unaffected, however far out they are.
 *
 * ## Why signatures
 *
 * Reconciling runs on boot and after every edit. Re-queueing everything each
 * time would mean dozens of Worker round-trips per launch. Each item carries a
 * `pushSig` fingerprint of the fields that affect its notifications; an item
 * whose fingerprint is unchanged is left alone.
 */

import { schedulePush, cancelPushPrefix } from "../push.js";
import { state, saveState } from "../state.js";
import { allItems, getList } from "./model.js";
import { occurrenceSeries, formatTime, MIN_MS, DAY_MS } from "./recur.js";

/** How many occurrences of one repeating reminder to hold in the queue. */
const OCCURRENCE_LIMIT = 24;
/** How far ahead to queue them, whichever limit is reached first. */
const HORIZON_MS = 120 * DAY_MS;
/**
 * Pushes closer than this are not worth queueing: the cron sweeps once a
 * minute and KV writes take time to become visible at the edge, so anything
 * inside the window would arrive after its moment anyway.
 */
const MIN_LEAD_MS = 30 * 1000;

export function pushTagPrefix(itemId){ return `rem-${itemId}-`; }

/**
 * The moment an item should alert: its due time, less any early warning. An
 * all-day reminder alerts at the configured hour, which is already baked into
 * dueAt when the date was set.
 */
export function alertTimeFor(item, occurrenceTs){
  return occurrenceTs - (item.earlyMin || 0) * MIN_MS;
}

/**
 * Everything about an item that changes what gets delivered, and when. Two
 * items with the same signature produce byte-identical notifications, so a
 * matching signature means there is nothing to re-queue.
 */
export function pushSignature(item){
  if(!item || item.completed || item.dueAt === null) return "off";
  const r = item.repeat;
  const repeat = r ? `${r.freq}/${r.interval}/${(r.weekdays || []).join(",")}/${r.until || 0}` : "-";
  return [
    item.dueAt, item.hasTime ? 1 : 0, repeat, item.earlyMin || 0,
    item.priority, item.listId, item.title, item.notes.slice(0, 120)
  ].join("|");
}

function notificationBody(item, occurrenceTs){
  const parts = [];
  const list = getList(item.listId);
  if(list) parts.push(`${list.icon} ${list.name}`);
  if(item.hasTime) parts.push(`Due ${formatTime(occurrenceTs)}`);
  if(item.notes.trim()) parts.push(item.notes.trim().split("\n")[0].slice(0, 120));
  const open = item.subtasks.filter(s => !s.done).length;
  if(open) parts.push(`${open} subtask${open === 1 ? "" : "s"}`);
  return parts.join(" • ") || "Reminder";
}

function notificationTitle(item){
  // Priority reads as exclamation marks on the title, the way iOS shows it.
  const marks = ["", "! ", "!! ", "!!! "][item.priority] || "";
  return `${marks}${item.title || "Reminder"}`.slice(0, 120);
}

/**
 * Queues every upcoming alert for one item, replacing whatever was queued
 * before. Returns the number of pushes accepted by the Worker.
 */
async function scheduleItem(item, now){
  await cancelPushPrefix(pushTagPrefix(item.id), { silent: true });

  if(item.completed || item.dueAt === null) return 0;

  const occurrences = occurrenceSeries(item.dueAt, item.repeat, {
    // Work back from the alert time so an early warning on an imminent
    // reminder is not skipped for being in the past.
    after: now + MIN_LEAD_MS + (item.earlyMin || 0) * MIN_MS,
    limit: OCCURRENCE_LIMIT,
    horizonMs: HORIZON_MS
  });

  const url = `${location.origin}${location.pathname}#reminder/${item.id}`;
  let queued = 0;
  for(const occurrenceTs of occurrences){
    const sendAt = alertTimeFor(item, occurrenceTs);
    if(sendAt < now + MIN_LEAD_MS) continue;
    const ok = await schedulePush(
      `${pushTagPrefix(item.id)}${occurrenceTs}`,
      notificationTitle(item),
      notificationBody(item, occurrenceTs),
      sendAt,
      { url, kind: "reminder" },
      { silent: true }
    );
    if(!ok) break;   // The Worker is unreachable; stop hammering it.
    queued++;
  }
  return queued;
}

/**
 * Brings the push queue in line with the current reminders.
 *
 * Safe to call often — an unchanged item costs nothing. Returns a summary so
 * the diagnostics panel in Settings can show what happened.
 */
export async function reconcileReminderPushes(opts = {}){
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const force = !!opts.force;
  const summary = { skipped: 0, scheduled: 0, cleared: 0, queued: 0, disabled: false };

  if(!state.settings.pushEnabled){
    // Nothing is queued server-side while push is off, so drop the stored
    // fingerprints: enabling push later must re-queue everything.
    summary.disabled = true;
    let dirty = false;
    for(const item of allItems()){
      if(item.pushSig !== null){ item.pushSig = null; dirty = true; }
    }
    if(dirty) saveState();
    return summary;
  }

  for(const item of allItems()){
    const sig = pushSignature(item);
    if(!force && item.pushSig === sig){ summary.skipped++; continue; }

    if(sig === "off"){
      await cancelPushPrefix(pushTagPrefix(item.id), { silent: true });
      summary.cleared++;
    } else {
      summary.queued += await scheduleItem(item, now);
      summary.scheduled++;
    }
    item.pushSig = sig;
    saveState();
  }
  return summary;
}

/** Clears the queue for reminders that no longer exist. */
export async function cancelRemindersPushes(itemIds){
  for(const id of itemIds){
    await cancelPushPrefix(pushTagPrefix(id), { silent: true });
  }
}

/**
 * Coalesces the reconcile calls fired by a burst of edits. The UI calls this
 * after every mutation; only the last one in a burst reaches the network.
 */
let pending = null;
export function scheduleReconcile(delayMs = 600){
  if(pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    reconcileReminderPushes().catch(e => console.error("[reminders] reconcile failed:", e));
  }, delayMs);
}

/**
 * Forgets every stored fingerprint, so the next reconcile re-queues the lot.
 * Used when push is re-enabled and after an import.
 */
export function invalidateAllPushSignatures(){
  for(const item of allItems()) item.pushSig = null;
  saveState();
}
