/** Persistent state, day keying, and time formatting. */
import { RESET_HOUR, STORAGE_KEY, DEFAULT_SETTINGS } from "./config.js";
import { normalizeReminders } from "./reminders/schema.js";
import { normalizeWeatherSettings } from "./weather/settings.js";
import { safeUUID } from "./uid.js";

export { safeUUID };

export function now(){ return new Date(); }

// The logbook day starts at RESET_HOUR local time, so anything logged between
// midnight and 4am belongs to the previous calendar day.
//
// Reading the local wall-clock hour and stepping the calendar date back is
// correct in every timezone and across both DST transitions. An earlier version
// subtracted 4 hours and then read the date via toISOString(), which is UTC — so
// the rollover landed at 4am only at UTC+0. In US Eastern it fired at midnight
// in summer and 11pm in winter, moving with DST twice a year.
export function dayKey(d = now()){
  const local = new Date(d.getTime());
  if(local.getHours() < RESET_HOUR) local.setDate(local.getDate() - 1);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The instants a logbook day runs between: RESET_HOUR local on its own date,
 * to RESET_HOUR local the next day.
 *
 * Built with local setters and setDate(), never by adding 24h — the day either
 * side of a DST change is 23 or 25 hours long, and "everything due today" has
 * to keep meaning that on those two mornings a year.
 */
export function dayBounds(d = now()){
  const start = new Date(d.getTime());
  if(start.getHours() < RESET_HOUR) start.setDate(start.getDate() - 1);
  start.setHours(RESET_HOUR, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

export function fmtTime(ts){
  if(!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// The morning check-in is on by default: it only does anything once push is
// enabled. queuedThrough is the last morning handed to the Worker — see checkin.js.
function normalizeCheckinSettings(raw){
  const base = (raw && typeof raw === "object") ? raw : {};
  const through = Number(base.queuedThrough);
  return {
    enabled: base.enabled !== false,
    queuedThrough: (base.queuedThrough != null && Number.isFinite(through)) ? through : null
  };
}

// Guarantees deviceId/days/settings always exist, so nothing downstream can
// crash on a partial or hand-edited state blob.
export function normalizeState(raw){
  const base = (raw && typeof raw === "object") ? raw : {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, base.settings || {});
  // Object.assign is shallow, so a stored settings blob replaces the nested
  // weather default wholesale rather than merging into it.
  settings.weather = normalizeWeatherSettings(settings.weather);
  settings.checkin = normalizeCheckinSettings(settings.checkin);
  return {
    deviceId: base.deviceId || safeUUID(),
    days: (base.days && typeof base.days === "object") ? base.days : {},
    settings,
    reminders: normalizeReminders(base.reminders)
  };
}

function loadState(){
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch {}
  return normalizeState(parsed);
}

/**
 * Exported as a live binding: importers see reassignment done by
 * replaceState(). Never reassign this from outside this module.
 */
export let state = loadState();

export function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Replaces state wholesale (import/restore), keeping this device's identity. */
export function replaceState(raw){
  const keepDeviceId = state.deviceId;
  state = normalizeState(raw);
  state.deviceId = keepDeviceId;
  saveState();
}

export function ensureDay(k){
  if(!state.days[k]){
    state.days[k] = {
      createdAt: Date.now(),
      outcomes: ["", "", ""],
      outcomesDone: [false, false, false],
      events: { imUp: null, babyUp: null, napStart: null, napEnd: null },
      morning: { movement: null, shower: null, outcomesWritten: null, meds: null }
    };
  }
  return state.days[k];
}

export function buildSuggestions(){
  const keys = Object.keys(state.days).sort().reverse();
  for(const k of keys){
    const d = state.days[k];
    if(!d?.outcomes?.length) continue;
    const idx = (d.outcomesDone || []).findIndex(x => !x);
    if(idx !== -1 && d.outcomes[idx]?.trim()){
      return { current: `Finish: ${d.outcomes[idx].trim()}` };
    }
  }
  return { current: "" };
}

saveState();
