/**
 * Natural-language parsing for the quick-add field, the way typing
 * "call the pediatrician tomorrow at 9am every 3 months !!" into iOS Reminders
 * fills in the date, the repeat and the priority for you.
 *
 * The parser is deliberately conservative: a phrase it does not recognise is
 * left in the title rather than guessed at. Everything it does consume is
 * reported in `matched` so the UI can show what it took.
 */

import { atTime, addDays, addMonths, addYears, daysInMonth, alignToRule, MIN_MS, HOUR_MS } from "./recur.js";

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
};

const WEEKDAY_WORDS = Object.keys(WEEKDAYS).join("|");
const MONTH_WORDS = Object.keys(MONTHS).join("|");

/** Times of day the named parts of the day map onto. */
const DAYPART_HOURS = { morning: 9, noon: 12, afternoon: 14, evening: 19, tonight: 20, midnight: 0 };

/**
 * @param {string} input       raw text from the quick-add field
 * @param {object} [opts]
 * @param {Date|number} [opts.now]              reference instant, for tests
 * @param {number} [opts.allDayAlertHour]       hour a dateless-time reminder alerts
 * @returns {{title, dueAt, hasTime, repeat, priority, tags, matched}}
 */
export function parseQuickAdd(input, opts = {}){
  const now = new Date(opts.now ?? Date.now());
  const allDayHour = Number.isFinite(opts.allDayAlertHour) ? opts.allDayAlertHour : 9;

  let text = ` ${String(input || "")} `;
  const matched = [];

  /**
   * Applies the first match of `re`, hands the groups to `fn`, and cuts the
   * matched span out of the text so a later pattern cannot claim it twice.
   */
  const cut = (re, fn) => {
    const m = re.exec(text);
    if(!m) return false;
    if(fn(m) === false) return false;
    matched.push(m[0].trim());
    text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
    return true;
  };

  const out = {
    title: "",
    dueAt: null,
    hasTime: false,
    repeat: null,
    priority: 0,
    tags: [],
    matched
  };

  // ---- priority: !, !!, !!! ------------------------------------------------
  cut(/(?<=\s)(!{1,3})(?=\s)/, (m) => { out.priority = m[1].length; });

  // ---- tags: #groceries ---------------------------------------------------
  // Repeated rather than global so each cut re-scans the shortened string.
  while(cut(/(?<=\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)(?=\s)/u, (m) => {
    const tag = m[1].toLowerCase();
    if(!out.tags.includes(tag)) out.tags.push(tag);
  })){ /* keep taking tags */ }

  // ---- repeat -------------------------------------------------------------
  // Ordered most specific first: "every 2 weeks" must win over "every week".
  cut(/(?<=\s)every\s+(\d{1,3})\s+(hour|day|week|month|year)s?(?=\s)/i, (m) => {
      out.repeat = { freq: freqOf(m[2]), interval: Number(m[1]) };
    })
    || cut(/(?<=\s)every\s+other\s+(hour|day|week|month|year)(?=\s)/i, (m) => {
      out.repeat = { freq: freqOf(m[1]), interval: 2 };
    })
    || cut(/(?<=\s)every\s+week\s?day(?=\s)/i, () => { out.repeat = { freq: "weekdays", interval: 1 }; })
    || cut(/(?<=\s)every\s+week\s?end(?:\s+day)?(?=\s)/i, () => { out.repeat = { freq: "weekends", interval: 1 }; })
    || cut(new RegExp(`(?<=\\s)every\\s+(${WEEKDAY_WORDS})(?=\\s)`, "i"), (m) => {
      out.repeat = { freq: "weekly", interval: 1, weekdays: [WEEKDAYS[m[1].toLowerCase()]] };
    })
    || cut(/(?<=\s)every\s+(hour|day|week|month|year)(?=\s)/i, (m) => {
      out.repeat = { freq: freqOf(m[1]), interval: 1 };
    })
    || cut(/(?<=\s)(hourly|daily|weekly|monthly|yearly|annually)(?=\s)/i, (m) => {
      const word = m[1].toLowerCase();
      out.repeat = { freq: word === "annually" ? "yearly" : word, interval: 1 };
    });

  // "every monday" already fixes the day; a bare weekday later in the string
  // would otherwise be read a second time as a one-off date.
  const repeatWeekday = out.repeat?.weekdays?.[0];

  // ---- explicit date ------------------------------------------------------
  let dateBase = null;   // start-of-day timestamp of the resolved date
  let timeSet = null;    // { hours, minutes } once a time is found

  const setDate = (ts) => { dateBase = ts; };

  cut(/(?<=\s)in\s+(\d{1,4})\s+(min|mins|minute|minutes|hour|hours|hr|hrs)(?=\s)/i, (m) => {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit.startsWith("h") ? n * HOUR_MS : n * MIN_MS;
    const t = new Date(now.getTime() + ms);
    setDate(t.getTime());
    timeSet = { hours: t.getHours(), minutes: t.getMinutes() };
  })
  || cut(/(?<=\s)in\s+(\d{1,4})\s+(day|days|week|weeks|month|months|year|years)(?=\s)/i, (m) => {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if(unit.startsWith("d")) setDate(addDays(now.getTime(), n));
    else if(unit.startsWith("w")) setDate(addDays(now.getTime(), n * 7));
    else if(unit.startsWith("m")) setDate(addMonths(now.getTime(), n));
    else setDate(addYears(now.getTime(), n));
  })
  || cut(/(?<=\s)(day\s+after\s+tomorrow)(?=\s)/i, () => { setDate(addDays(now.getTime(), 2)); })
  || cut(/(?<=\s)(tomorrow|tmrw|tmr|tmw)(?=\s)/i, () => { setDate(addDays(now.getTime(), 1)); })
  || cut(/(?<=\s)(today)(?=\s)/i, () => { setDate(now.getTime()); })
  || cut(new RegExp(`(?<=\\s)(?:on\\s+)?(?:the\\s+)?(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s)`, "i"), (m) => {
    const ts = monthDayToTs(now, MONTHS[m[1].toLowerCase()], Number(m[2]), m[3] && Number(m[3]));
    if(ts === null) return false;
    setDate(ts);
  })
  || cut(new RegExp(`(?<=\\s)(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORDS})\\.?(?:,?\\s+(\\d{4}))?(?=\\s)`, "i"), (m) => {
    const ts = monthDayToTs(now, MONTHS[m[2].toLowerCase()], Number(m[1]), m[3] && Number(m[3]));
    if(ts === null) return false;
    setDate(ts);
  })
  || cut(/(?<=\s)(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s)/i, (m) => {
    const ts = nextDayOfMonth(now, Number(m[1]));
    if(ts === null) return false;
    setDate(ts);
  })
  || cut(/(?<=\s)(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/, (m) => {
    const ts = monthDayToTs(now, Number(m[1]) - 1, Number(m[2]), m[3] && expandYear(Number(m[3])));
    if(ts === null) return false;
    setDate(ts);
  })
  || cut(new RegExp(`(?<=\\s)(?:(next|this)\\s+|on\\s+)?(${WEEKDAY_WORDS})(?=\\s)`, "i"), (m) => {
    const target = WEEKDAYS[m[2].toLowerCase()];
    // Skip a bare weekday that "every <weekday>" already accounted for.
    if(!m[1] && repeatWeekday === target) return false;
    setDate(nextWeekdayTs(now, target, (m[1] || "").toLowerCase() === "next"));
  });

  // ---- time ---------------------------------------------------------------
  if(!timeSet){
    cut(/(?<=\s)(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s)/i, (m) => {
      const raw = Number(m[1]);
      if(raw < 1 || raw > 12) return false;
      const pm = m[3].toLowerCase().startsWith("p");
      timeSet = { hours: (raw % 12) + (pm ? 12 : 0), minutes: m[2] ? Number(m[2]) : 0 };
      if(timeSet.minutes > 59) return (timeSet = null, false);
    })
    || cut(/(?<=\s)(?:at\s+|@\s*)(\d{1,2}):(\d{2})(?=\s)/, (m) => {
      const h = Number(m[1]), min = Number(m[2]);
      if(h > 23 || min > 59) return false;
      timeSet = { hours: h, minutes: min };
    })
    || cut(/(?<=\s)(?:at\s+|@\s*)(\d{1,2})(?=\s)/, (m) => {
      const h = Number(m[1]);
      if(h > 23) return false;
      // "at 5" means 5pm, "at 9" means 9am — the same guess iOS makes.
      timeSet = { hours: h >= 1 && h <= 7 ? h + 12 : h, minutes: 0 };
    })
    || cut(/(?<=\s)(noon|midday|midnight|this\s+morning|this\s+afternoon|this\s+evening|tonight|in\s+the\s+morning|in\s+the\s+afternoon|in\s+the\s+evening)(?=\s)/i, (m) => {
      const word = m[1].toLowerCase().replace(/^(this|in the)\s+/, "");
      const hour = DAYPART_HOURS[word === "midday" ? "noon" : word];
      if(hour === undefined) return false;
      timeSet = { hours: hour, minutes: 0 };
      // "tonight" and "this morning" name a day as well as a time.
      if(dateBase === null && (word === "tonight" || m[1].toLowerCase().startsWith("this "))){
        setDate(now.getTime());
      }
    });
  }

  // ---- assemble -----------------------------------------------------------
  if(dateBase !== null || timeSet !== null){
    const base = dateBase !== null ? dateBase : now.getTime();
    if(timeSet){
      out.dueAt = atTime(base, timeSet.hours, timeSet.minutes);
      out.hasTime = true;
      // A time with no date means the next time it comes round, not one that
      // has already gone by this morning.
      if(dateBase === null && out.dueAt <= now.getTime()) out.dueAt = addDays(out.dueAt, 1);
    } else {
      out.dueAt = atTime(base, allDayHour, 0);
      out.hasTime = false;
    }
  }

  // A repeat with nothing to repeat from starts today.
  if(out.repeat && out.dueAt === null){
    out.dueAt = atTime(now.getTime(), allDayHour, 0);
    out.hasTime = false;
  }

  // "every monday" has to start on a Monday. The start date here was inferred
  // rather than chosen, so it is safe to move it onto a day the rule allows.
  if(out.repeat && out.dueAt !== null){
    out.dueAt = alignToRule(out.dueAt, out.repeat);
    if(out.dueAt <= now.getTime()){
      // Aligning can land on today at an hour that has already passed.
      const bumped = alignToRule(addDays(out.dueAt, 1), out.repeat);
      out.dueAt = bumped;
    }
  }

  out.title = tidyTitle(text);
  return out;
}

function freqOf(unit){
  const u = unit.toLowerCase();
  if(u === "day") return "daily";
  if(u === "hour") return "hourly";
  return `${u}ly`;
}

function expandYear(y){
  return y < 100 ? 2000 + y : y;
}

/**
 * A month/day with no year means the next time that date comes round: "Jan 4"
 * typed in December is next year, not ten months ago.
 */
function monthDayToTs(now, monthIndex, day, explicitYear){
  if(!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) return null;
  if(!Number.isInteger(day) || day < 1) return null;
  let year = explicitYear || now.getFullYear();
  if(day > daysInMonth(year, monthIndex)) return null;
  const d = new Date(year, monthIndex, day, now.getHours(), now.getMinutes(), 0, 0);
  if(!explicitYear && d.getTime() < now.getTime() - 12 * HOUR_MS){
    year += 1;
    if(day > daysInMonth(year, monthIndex)) return null;
    d.setFullYear(year);
  }
  return d.getTime();
}

/** The next time a bare day of month ("the 15th") comes round. */
function nextDayOfMonth(now, day){
  if(!Number.isInteger(day) || day < 1 || day > 31) return null;
  for(let ahead = 0; ahead < 14; ahead++){
    const probe = addMonths(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), ahead);
    const p = new Date(probe);
    if(day > daysInMonth(p.getFullYear(), p.getMonth())) continue;
    const candidate = new Date(p.getFullYear(), p.getMonth(), day, now.getHours(), now.getMinutes(), 0, 0);
    if(candidate.getTime() >= now.getTime()) return candidate.getTime();
  }
  return null;
}

/**
 * "friday" is the coming Friday (today counts only if it is still ahead of us
 * as a whole day); "next friday" always skips a week.
 */
function nextWeekdayTs(now, target, forceNextWeek){
  const dow = now.getDay();
  let delta = (target - dow + 7) % 7;
  if(delta === 0) delta = 7;              // "monday" said on a Monday means the next one
  if(forceNextWeek && delta < 7) delta += 7;
  return addDays(now.getTime(), delta);
}

function tidyTitle(text){
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
}
