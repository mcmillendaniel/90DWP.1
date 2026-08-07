/**
 * Repeat rules and date arithmetic for reminders.
 *
 * Every calculation in this file works in LOCAL wall-clock terms, using Date's
 * local getters and setters. Never reach for UTC or for millisecond offsets
 * here: adding 24h to a timestamp is not the same as "the next day" across a
 * DST transition, and a 9:00am daily reminder must stay at 9:00am on both sides
 * of the clock change. See the dayKey() comment in state.js for what the UTC
 * version of this mistake looked like in production.
 *
 * A repeat rule is:
 *   { freq, interval, weekdays?, until? }
 *     freq     "hourly" | "daily" | "weekdays" | "weekends" | "weekly"
 *              | "monthly" | "yearly"
 *     interval positive integer, every N of freq
 *     weekdays optional array of 0-6 (Sun-Sat), weekly only
 *     until    optional epoch ms; no occurrence is produced after it
 *   null / undefined means "does not repeat".
 */

export const MIN_MS = 60 * 1000;
export const HOUR_MS = 60 * MIN_MS;
export const DAY_MS = 24 * HOUR_MS;

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The repeat choices offered in the editor, mirroring the iOS Reminders set. */
export const REPEAT_PRESETS = [
  { id: "none", label: "Never", rule: null },
  { id: "hourly", label: "Hourly", rule: { freq: "hourly", interval: 1 } },
  { id: "daily", label: "Daily", rule: { freq: "daily", interval: 1 } },
  { id: "weekdays", label: "Every weekday", rule: { freq: "weekdays", interval: 1 } },
  { id: "weekends", label: "Every weekend day", rule: { freq: "weekends", interval: 1 } },
  { id: "weekly", label: "Weekly", rule: { freq: "weekly", interval: 1 } },
  { id: "biweekly", label: "Every 2 weeks", rule: { freq: "weekly", interval: 2 } },
  { id: "monthly", label: "Monthly", rule: { freq: "monthly", interval: 1 } },
  { id: "quarterly", label: "Every 3 months", rule: { freq: "monthly", interval: 3 } },
  { id: "semiannually", label: "Every 6 months", rule: { freq: "monthly", interval: 6 } },
  { id: "yearly", label: "Yearly", rule: { freq: "yearly", interval: 1 } }
];

const VALID_FREQ = new Set(["hourly", "daily", "weekdays", "weekends", "weekly", "monthly", "yearly"]);

// ---------------------------------------------------------------- primitives

export function daysInMonth(year, monthIndex){
  // Day 0 of the following month is the last day of this one.
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function startOfDay(ts){
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts){
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function isSameDay(a, b){
  if(a == null || b == null) return false;
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

/** Whole calendar days between two instants, ignoring the time of day. */
export function dayDiff(from, to){
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

/** Adds calendar days, keeping the local wall-clock time across DST. */
export function addDays(ts, n){
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * Adds calendar months, clamping the day of month rather than overflowing.
 * Jan 31 + 1 month is Feb 28 (or 29), not Mar 3.
 */
export function addMonths(ts, n){
  const d = new Date(ts);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d.getTime();
}

/** Adds years, clamping Feb 29 to Feb 28 in a non-leap year. */
export function addYears(ts, n){
  const d = new Date(ts);
  const day = d.getDate();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + n);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d.getTime();
}

/** Replaces the time of day on a timestamp, leaving the calendar date alone. */
export function atTime(ts, hours, minutes = 0){
  const d = new Date(ts);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

export function isWeekend(ts){
  const dow = new Date(ts).getDay();
  return dow === 0 || dow === 6;
}

// ------------------------------------------------------------------- rules

export function normalizeRepeat(raw){
  if(!raw || typeof raw !== "object") return null;
  if(!VALID_FREQ.has(raw.freq)) return null;
  const rule = {
    freq: raw.freq,
    interval: Math.max(1, Math.min(999, Math.floor(Number(raw.interval)) || 1))
  };
  if(raw.freq === "weekly" && Array.isArray(raw.weekdays)){
    const days = [...new Set(raw.weekdays.map(Number))]
      .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if(days.length) rule.weekdays = days;
  }
  if(Number.isFinite(raw.until) && raw.until > 0) rule.until = Number(raw.until);
  return rule;
}

/** Matches a rule back to a preset id, or "custom" when nothing lines up. */
export function repeatPresetId(rule){
  if(!rule) return "none";
  for(const p of REPEAT_PRESETS){
    if(!p.rule) continue;
    if(p.rule.freq === rule.freq && p.rule.interval === rule.interval && !rule.weekdays) return p.id;
  }
  return "custom";
}

export function repeatLabel(rule){
  if(!rule) return "Never";
  const preset = REPEAT_PRESETS.find(p => p.id === repeatPresetId(rule));
  let base;
  if(preset && preset.rule){
    base = preset.label;
  } else if(rule.freq === "weekly" && rule.weekdays?.length){
    base = rule.interval === 1
      ? `Every ${rule.weekdays.map(d => WEEKDAY_SHORT[d]).join(", ")}`
      : `Every ${rule.interval} weeks on ${rule.weekdays.map(d => WEEKDAY_SHORT[d]).join(", ")}`;
  } else {
    const unit = { hourly: "hour", daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq] || rule.freq;
    base = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  }
  if(rule.until) base += ` until ${formatDate(rule.until)}`;
  return base;
}

/**
 * The first occurrence strictly after `ts`. Returns null when the rule is
 * absent, unrecognised, or has run past its end date.
 */
export function nextOccurrence(ts, rule){
  if(!rule || !VALID_FREQ.has(rule.freq)) return null;
  const interval = Math.max(1, Math.floor(Number(rule.interval)) || 1);
  let next;

  switch(rule.freq){
    case "hourly":
      next = ts + interval * HOUR_MS;
      break;
    case "daily":
      next = addDays(ts, interval);
      break;
    case "weekdays": {
      next = addDays(ts, 1);
      while(isWeekend(next)) next = addDays(next, 1);
      break;
    }
    case "weekends": {
      next = addDays(ts, 1);
      while(!isWeekend(next)) next = addDays(next, 1);
      break;
    }
    case "weekly":
      next = nextWeekly(ts, interval, rule.weekdays);
      break;
    case "monthly":
      next = addMonths(ts, interval);
      break;
    case "yearly":
      next = addYears(ts, interval);
      break;
    default:
      return null;
  }

  if(!Number.isFinite(next) || next <= ts) return null;
  if(rule.until && next > rule.until) return null;
  return next;
}

function nextWeekly(ts, interval, weekdays){
  if(!Array.isArray(weekdays) || !weekdays.length) return addDays(ts, 7 * interval);
  const days = [...new Set(weekdays.map(Number))].filter(d => d >= 0 && d <= 6).sort((a, b) => a - b);
  if(!days.length) return addDays(ts, 7 * interval);
  const dow = new Date(ts).getDay();
  const later = days.find(d => d > dow);
  // Still days left in this week, otherwise wrap to the first selected day of
  // the week `interval` weeks out.
  if(later !== undefined) return addDays(ts, later - dow);
  return addDays(ts, (7 * interval) - dow + days[0]);
}

/**
 * Moves a timestamp forward to the first day the rule actually falls on,
 * keeping its time of day. "Every Monday" starting on a Wednesday, or "every
 * weekday" starting on a Saturday, would otherwise fire on a day the rule
 * excludes.
 *
 * Only the quick-add parser applies this, where the start date was inferred.
 * The editor leaves an explicitly chosen date alone.
 */
export function alignToRule(ts, rule){
  if(!Number.isFinite(ts) || !rule) return ts;
  const matches = (t) => {
    const dow = new Date(t).getDay();
    if(rule.freq === "weekdays") return dow >= 1 && dow <= 5;
    if(rule.freq === "weekends") return dow === 0 || dow === 6;
    if(rule.freq === "weekly" && rule.weekdays?.length) return rule.weekdays.includes(dow);
    return true;
  };
  let cur = ts;
  for(let i = 0; i < 7 && !matches(cur); i++) cur = addDays(cur, 1);
  return cur;
}

/**
 * Advances a due date past `now`, the way completing (or missing) a repeating
 * reminder moves it to its next occurrence.
 *
 * Returns { dueAt, skipped, ended }. `ended` means the rule's end date has
 * passed, in which case dueAt is the last occurrence and the caller should drop
 * the repeat.
 */
export function rollForward(dueAt, rule, now = Date.now()){
  if(!Number.isFinite(dueAt)) return { dueAt, skipped: 0, ended: false };
  if(!rule) return { dueAt, skipped: 0, ended: false };
  let cur = dueAt;
  let skipped = 0;
  // Bounded so a pathological rule (or a decade-old hourly reminder) cannot
  // spin the main thread.
  const MAX_STEPS = 10000;
  while(cur <= now && skipped < MAX_STEPS){
    const next = nextOccurrence(cur, rule);
    if(next === null) return { dueAt: cur, skipped, ended: true };
    cur = next;
    skipped++;
  }
  return { dueAt: cur, skipped, ended: false };
}

/**
 * The upcoming occurrences to hand to the push queue.
 *
 * Repeats are expanded on the client and queued ahead of time rather than being
 * unrolled by the Worker, which stays a dumb queue. Coverage is bounded by both
 * `limit` and `horizonMs`, whichever is hit first, but at least one occurrence
 * is always returned so a yearly reminder is never dropped for being far away.
 * The window is re-topped-up every time the app opens.
 */
export function occurrenceSeries(dueAt, rule, opts = {}){
  const after = Number.isFinite(opts.after) ? opts.after : Date.now();
  const limit = Number.isFinite(opts.limit) ? opts.limit : 24;
  const horizonMs = Number.isFinite(opts.horizonMs) ? opts.horizonMs : 120 * DAY_MS;
  const out = [];
  if(!Number.isFinite(dueAt)) return out;

  let cur = dueAt;
  let guard = 0;
  const MAX_STEPS = 10000;

  // Skip occurrences already in the past — a missed reminder must not fire
  // again the next time the app is opened.
  while(cur <= after && guard++ < MAX_STEPS){
    const next = nextOccurrence(cur, rule);
    if(next === null) return out;
    cur = next;
  }
  if(cur <= after) return out;

  out.push(cur);
  if(!rule) return out;

  while(out.length < limit && guard++ < MAX_STEPS){
    const next = nextOccurrence(cur, rule);
    if(next === null) break;
    if(next - after > horizonMs) break;
    out.push(next);
    cur = next;
  }
  return out;
}

// -------------------------------------------------------------- formatting

export function formatTime(ts){
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDate(ts){
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

/**
 * "Today at 5:00 PM", "Tomorrow", "Yesterday", "Mon, Mar 3".
 * Days within the coming week are named, anything further out gets a date.
 */
export function formatDueLabel(dueAt, hasTime, now = Date.now()){
  if(!Number.isFinite(dueAt)) return "";
  const diff = dayDiff(now, dueAt);
  let day;
  if(diff === 0) day = "Today";
  else if(diff === 1) day = "Tomorrow";
  else if(diff === -1) day = "Yesterday";
  else if(diff > 1 && diff < 7) day = WEEKDAY_NAMES[new Date(dueAt).getDay()];
  else day = formatDate(dueAt);
  return hasTime ? `${day} at ${formatTime(dueAt)}` : day;
}

/** The <input type="date"> value for a timestamp, in local time. */
export function toDateInputValue(ts){
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The <input type="time"> value for a timestamp, in local time. */
export function toTimeInputValue(ts){
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Applies a "YYYY-MM-DD" input value to a timestamp, keeping its time of day.
 * Parsed field by field — `new Date("2026-03-15")` is UTC midnight, which lands
 * on the previous day for anyone west of Greenwich.
 */
export function fromDateInputValue(value, keepTimeFrom = Date.now()){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if(!m) return null;
  const base = new Date(keepTimeFrom);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    base.getHours(), base.getMinutes(), 0, 0);
  return d.getTime();
}

/** Applies a "HH:MM" input value to a timestamp, keeping its calendar date. */
export function fromTimeInputValue(value, keepDateFrom = Date.now()){
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || "").trim());
  if(!m) return null;
  const hours = Number(m[1]), minutes = Number(m[2]);
  if(hours > 23 || minutes > 59) return null;
  return atTime(keepDateFrom, hours, minutes);
}
