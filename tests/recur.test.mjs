/**
 * Date arithmetic and repeat rules.
 *
 * Run with:  TZ=America/New_York node --test tests/
 *
 * The timezone matters. dayKey() was wrong for a year because the arithmetic
 * ran in UTC and only looked right at UTC+0, so these tests deliberately pin a
 * zone with DST and assert on local wall-clock results.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays, addMonths, addYears, atTime, alignToRule, daysInMonth,
  nextOccurrence, occurrenceSeries, rollForward, normalizeRepeat,
  repeatPresetId, repeatLabel, formatDueLabel, dayDiff,
  fromDateInputValue, fromTimeInputValue, toDateInputValue, toTimeInputValue
} from "../js/reminders/recur.js";

const at = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const show = (ts) => new Date(ts).toString().slice(0, 24);

test("addDays keeps the wall-clock time across spring forward", () => {
  // US Eastern springs forward 2026-03-08. A 9am reminder stays at 9am.
  const before = at(2026, 3, 7, 9);
  assert.equal(show(addDays(before, 1)), show(at(2026, 3, 8, 9)));
  assert.equal(new Date(addDays(before, 1)).getHours(), 9);
});

test("addDays keeps the wall-clock time across fall back", () => {
  // US Eastern falls back 2026-11-01.
  const before = at(2026, 10, 31, 9);
  assert.equal(new Date(addDays(before, 2)).getHours(), 9);
  assert.equal(new Date(addDays(before, 2)).getDate(), 2);
});

test("addMonths clamps rather than overflowing", () => {
  assert.equal(show(addMonths(at(2026, 1, 31), 1)), show(at(2026, 2, 28)));
  assert.equal(show(addMonths(at(2028, 1, 31), 1)), show(at(2028, 2, 29)));
  assert.equal(show(addMonths(at(2026, 3, 31), 1)), show(at(2026, 4, 30)));
  assert.equal(show(addMonths(at(2026, 12, 15), 1)), show(at(2027, 1, 15)));
});

test("addYears clamps Feb 29 in a non-leap year", () => {
  assert.equal(show(addYears(at(2028, 2, 29), 1)), show(at(2029, 2, 28)));
  assert.equal(show(addYears(at(2028, 2, 29), 4)), show(at(2032, 2, 29)));
});

test("daysInMonth handles leap years", () => {
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2028, 1), 29);
  assert.equal(daysInMonth(2100, 1), 28);
});

test("daily and hourly repeats advance by their interval", () => {
  const start = at(2026, 3, 4, 9);
  assert.equal(show(nextOccurrence(start, { freq: "daily", interval: 1 })), show(at(2026, 3, 5, 9)));
  assert.equal(show(nextOccurrence(start, { freq: "daily", interval: 3 })), show(at(2026, 3, 7, 9)));
  assert.equal(show(nextOccurrence(start, { freq: "hourly", interval: 2 })), show(at(2026, 3, 4, 11)));
});

test("weekday and weekend repeats skip the days they exclude", () => {
  const friday = at(2026, 3, 6, 9);
  assert.equal(new Date(nextOccurrence(friday, { freq: "weekdays", interval: 1 })).getDay(), 1);
  const saturday = at(2026, 3, 7, 9);
  assert.equal(new Date(nextOccurrence(saturday, { freq: "weekends", interval: 1 })).getDay(), 0);
  const sunday = at(2026, 3, 8, 9);
  assert.equal(new Date(nextOccurrence(sunday, { freq: "weekends", interval: 1 })).getDay(), 6);
});

test("weekly with selected days cycles through them then wraps by interval", () => {
  // Mon/Wed/Fri, starting on a Monday.
  const rule = { freq: "weekly", interval: 1, weekdays: [1, 3, 5] };
  let ts = at(2026, 3, 2, 9);                      // Monday
  assert.equal(new Date(ts).getDay(), 1);
  ts = nextOccurrence(ts, rule);
  assert.equal(new Date(ts).getDay(), 3);          // Wednesday
  ts = nextOccurrence(ts, rule);
  assert.equal(new Date(ts).getDay(), 5);          // Friday
  ts = nextOccurrence(ts, rule);
  assert.equal(new Date(ts).getDay(), 1);          // back to Monday
  assert.equal(show(ts), show(at(2026, 3, 9, 9))); // the following week

  // Every 2 weeks on Monday jumps a fortnight, not a week.
  const fortnightly = { freq: "weekly", interval: 2, weekdays: [1] };
  assert.equal(show(nextOccurrence(at(2026, 3, 2, 9), fortnightly)), show(at(2026, 3, 16, 9)));
});

test("an end date stops the series", () => {
  const rule = { freq: "daily", interval: 1, until: at(2026, 3, 6, 23) };
  assert.ok(nextOccurrence(at(2026, 3, 5, 9), rule));
  assert.equal(nextOccurrence(at(2026, 3, 6, 9), rule), null);
});

test("occurrenceSeries skips the past and respects both bounds", () => {
  const now = at(2026, 3, 4, 10);
  const daily = { freq: "daily", interval: 1 };

  // Started a month ago; the first result must still be in the future.
  const series = occurrenceSeries(at(2026, 2, 1, 9), daily, { after: now, limit: 5 });
  assert.equal(series.length, 5);
  assert.ok(series[0] > now);
  assert.equal(show(series[0]), show(at(2026, 3, 5, 9)));

  // The horizon caps a long series before the limit does.
  const capped = occurrenceSeries(at(2026, 3, 5, 9), daily, {
    after: now, limit: 100, horizonMs: 10 * 24 * 3600 * 1000
  });
  assert.ok(capped.length <= 11, `expected the horizon to cap the series, got ${capped.length}`);

  // A one-off in the past produces nothing, so a missed reminder cannot
  // re-fire the next time the app opens.
  assert.deepEqual(occurrenceSeries(at(2026, 3, 1, 9), null, { after: now }), []);

  // A one-off in the future is queued however far out it is.
  const distant = occurrenceSeries(at(2030, 6, 1, 9), null, { after: now });
  assert.equal(distant.length, 1);

  // So is the next occurrence of a rare repeat.
  const yearly = occurrenceSeries(at(2027, 1, 1, 9), { freq: "yearly", interval: 1 }, { after: now });
  assert.ok(yearly.length >= 1);
});

test("rollForward lands on the first occurrence after now", () => {
  const now = at(2026, 3, 4, 10);
  const { dueAt, ended } = rollForward(at(2026, 1, 1, 9), { freq: "weekly", interval: 1 }, now);
  assert.equal(ended, false);
  assert.ok(dueAt > now);
  assert.equal(new Date(dueAt).getDay(), new Date(at(2026, 1, 1, 9)).getDay());

  const finished = rollForward(at(2026, 1, 1, 9), { freq: "daily", interval: 1, until: at(2026, 2, 1) }, now);
  assert.equal(finished.ended, true);
});

test("alignToRule moves onto a day the rule allows", () => {
  const wednesday = at(2026, 3, 4, 9);
  const monday = alignToRule(wednesday, { freq: "weekly", interval: 1, weekdays: [1] });
  assert.equal(new Date(monday).getDay(), 1);
  assert.equal(new Date(monday).getHours(), 9);

  const saturday = at(2026, 3, 7, 9);
  assert.equal(new Date(alignToRule(saturday, { freq: "weekdays", interval: 1 })).getDay(), 1);

  // A rule with no day restriction leaves the date alone.
  assert.equal(alignToRule(wednesday, { freq: "daily", interval: 1 }), wednesday);
});

test("normalizeRepeat rejects junk and clamps intervals", () => {
  assert.equal(normalizeRepeat(null), null);
  assert.equal(normalizeRepeat({ freq: "fortnightly" }), null);
  assert.equal(normalizeRepeat({ freq: "daily", interval: 0 }).interval, 1);
  assert.equal(normalizeRepeat({ freq: "daily", interval: -5 }).interval, 1);
  assert.equal(normalizeRepeat({ freq: "daily", interval: 99999 }).interval, 999);
  assert.deepEqual(normalizeRepeat({ freq: "weekly", weekdays: [9, 1, 1, 3] }).weekdays, [1, 3]);
  // Weekday selection is meaningless outside a weekly rule.
  assert.equal(normalizeRepeat({ freq: "daily", weekdays: [1] }).weekdays, undefined);
});

test("preset ids and labels round-trip", () => {
  assert.equal(repeatPresetId(null), "none");
  assert.equal(repeatPresetId({ freq: "daily", interval: 1 }), "daily");
  assert.equal(repeatPresetId({ freq: "weekly", interval: 2 }), "biweekly");
  assert.equal(repeatPresetId({ freq: "monthly", interval: 3 }), "quarterly");
  assert.equal(repeatPresetId({ freq: "daily", interval: 5 }), "custom");
  assert.equal(repeatLabel(null), "Never");
  assert.equal(repeatLabel({ freq: "daily", interval: 5 }), "Every 5 days");
  assert.equal(repeatLabel({ freq: "weekly", interval: 1, weekdays: [1, 3] }), "Every Mon, Wed");
});

test("formatDueLabel names nearby days", () => {
  const now = at(2026, 3, 4, 10);
  assert.equal(formatDueLabel(at(2026, 3, 4, 17), true, now), "Today at 5:00 PM");
  assert.equal(formatDueLabel(at(2026, 3, 5, 9), false, now), "Tomorrow");
  assert.equal(formatDueLabel(at(2026, 3, 3, 9), false, now), "Yesterday");
  assert.equal(formatDueLabel(at(2026, 3, 7, 9), false, now), "Saturday");
  assert.equal(formatDueLabel(at(2026, 5, 7, 9), false, now), "May 7");
});

test("dayDiff counts calendar days, not 24-hour blocks", () => {
  assert.equal(dayDiff(at(2026, 3, 4, 23), at(2026, 3, 5, 1)), 1);
  assert.equal(dayDiff(at(2026, 3, 4, 1), at(2026, 3, 4, 23)), 0);
  // Across spring forward, where the calendar day is only 23 hours long.
  assert.equal(dayDiff(at(2026, 3, 7, 12), at(2026, 3, 8, 12)), 1);
});

test("date and time input values round-trip in local time", () => {
  const ts = at(2026, 3, 4, 17, 45);
  assert.equal(toDateInputValue(ts), "2026-03-04");
  assert.equal(toTimeInputValue(ts), "17:45");
  // Parsed field by field: new Date("2026-03-04") would be UTC midnight, which
  // is March 3rd anywhere west of Greenwich.
  assert.equal(toDateInputValue(fromDateInputValue("2026-03-04", ts)), "2026-03-04");
  assert.equal(new Date(fromDateInputValue("2026-03-04", ts)).getHours(), 17);
  assert.equal(toTimeInputValue(fromTimeInputValue("08:05", ts)), "08:05");
  assert.equal(new Date(fromTimeInputValue("08:05", ts)).getDate(), 4);
  assert.equal(fromDateInputValue("garbage", ts), null);
  assert.equal(fromTimeInputValue("99:99", ts), null);
});

test("atTime replaces the clock without moving the date", () => {
  const ts = atTime(at(2026, 3, 4, 23, 59), 0, 30);
  assert.equal(new Date(ts).getDate(), 4);
  assert.equal(new Date(ts).getHours(), 0);
  assert.equal(new Date(ts).getMinutes(), 30);
});
