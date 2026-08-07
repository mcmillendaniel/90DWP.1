/**
 * Quick-add natural-language parsing.
 *
 * Run with:  TZ=America/New_York node --test "tests/*.test.mjs"
 *
 * Every case pins `now` to Wednesday 4 March 2026, 10:30 local.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseQuickAdd } from "../js/reminders/parse.js";

const NOW = new Date(2026, 2, 4, 10, 30, 0, 0);   // Wed 4 Mar 2026, 10:30
const parse = (text) => parseQuickAdd(text, { now: NOW });
const due = (r) => (r.dueAt === null ? null : new Date(r.dueAt));

test("plain text stays a plain title", () => {
  const r = parse("buy milk");
  assert.equal(r.title, "buy milk");
  assert.equal(r.dueAt, null);
  assert.equal(r.repeat, null);
  assert.equal(r.priority, 0);
  assert.deepEqual(r.tags, []);
});

test("relative days", () => {
  assert.equal(due(parse("call mom tomorrow")).getDate(), 5);
  assert.equal(due(parse("call mom today")).getDate(), 4);
  assert.equal(due(parse("call mom day after tomorrow")).getDate(), 6);
  assert.equal(parse("call mom tomorrow").title, "call mom");
});

test("times, with and without a date", () => {
  const withDate = parse("standup tomorrow at 9:15am");
  assert.equal(withDate.title, "standup");
  assert.equal(withDate.hasTime, true);
  assert.equal(due(withDate).getHours(), 9);
  assert.equal(due(withDate).getMinutes(), 15);
  assert.equal(due(withDate).getDate(), 5);

  // 5pm today has not happened yet, so it stays today.
  const later = parse("tea at 5pm");
  assert.equal(due(later).getDate(), 4);
  assert.equal(due(later).getHours(), 17);

  // 8am today has already gone by, so it rolls to tomorrow.
  const passed = parse("meds at 8am");
  assert.equal(due(passed).getDate(), 5);
  assert.equal(due(passed).getHours(), 8);

  // A bare hour is read the way iOS reads it: 5 means 5pm, 9 means 9am.
  assert.equal(due(parse("tea at 5")).getHours(), 17);
  assert.equal(due(parse("gym at 9")).getHours(), 9);
  assert.equal(due(parse("meeting at 14:30")).getHours(), 14);
  assert.equal(due(parse("lunch at noon")).getHours(), 12);
  assert.equal(due(parse("trash out tonight")).getHours(), 20);
});

test("a date with no time is an all-day reminder", () => {
  const r = parse("taxes on 4/15");
  assert.equal(r.hasTime, false);
  assert.equal(due(r).getMonth(), 3);
  assert.equal(due(r).getDate(), 15);
  assert.equal(due(r).getHours(), 9, "all-day reminders alert at the configured hour");
});

test("month names, in both orders, with and without a year", () => {
  assert.equal(due(parse("renew passport march 20 2027")).getFullYear(), 2027);
  assert.equal(due(parse("party on 20 june")).getMonth(), 5);
  assert.equal(due(parse("dentist sept 3")).getMonth(), 8);
  // A month already behind us means next year, not ten months ago.
  const jan = parse("review jan 4");
  assert.equal(jan.dueAt > NOW.getTime(), true);
  assert.equal(due(jan).getFullYear(), 2027);
});

test("day of month", () => {
  const r = parse("pay rent on the 1st");
  assert.equal(r.title, "pay rent");
  assert.equal(due(r).getDate(), 1);
  assert.equal(due(r) > NOW, true);
});

test("weekdays, this week and next", () => {
  // Wednesday -> the coming Friday.
  assert.equal(due(parse("review notes friday")).getDate(), 6);
  // "next friday" skips a week.
  assert.equal(due(parse("review notes next friday")).getDate(), 13);
  // Naming today's weekday means the next one, not this morning.
  assert.equal(due(parse("thing wednesday")).getDate(), 11);
});

test("durations from now", () => {
  const mins = parse("check oven in 45 minutes");
  assert.equal(mins.title, "check oven");
  assert.equal(mins.hasTime, true);
  assert.equal(due(mins).getHours(), 11);
  assert.equal(due(mins).getMinutes(), 15);

  assert.equal(due(parse("gym in 2 hours")).getHours(), 12);
  assert.equal(due(parse("follow up in 3 days")).getDate(), 7);
  assert.equal(due(parse("follow up in 2 weeks")).getDate(), 18);
  assert.equal(due(parse("checkup in 1 month")).getMonth(), 3);
});

test("repeat rules", () => {
  assert.deepEqual(parse("water plants every 3 days").repeat, { freq: "daily", interval: 3 });
  assert.deepEqual(parse("meds daily").repeat, { freq: "daily", interval: 1 });
  assert.deepEqual(parse("report every week").repeat, { freq: "weekly", interval: 1 });
  assert.deepEqual(parse("rent every month").repeat, { freq: "monthly", interval: 1 });
  assert.deepEqual(parse("mot every year").repeat, { freq: "yearly", interval: 1 });
  assert.deepEqual(parse("bins every other week").repeat, { freq: "weekly", interval: 2 });
  assert.deepEqual(parse("standup every weekday").repeat, { freq: "weekdays", interval: 1 });
  assert.deepEqual(parse("lie in every weekend").repeat, { freq: "weekends", interval: 1 });
  assert.deepEqual(parse("dentist every monday").repeat, { freq: "weekly", interval: 1, weekdays: [1] });
  // "every 2 weeks" must beat the plainer "every week".
  assert.deepEqual(parse("sync every 2 weeks").repeat, { freq: "weekly", interval: 2 });
});

test("a repeat starts on a day the rule allows", () => {
  // Typed on a Wednesday, so the first occurrence has to be the coming Monday.
  const r = parse("dentist every monday");
  assert.equal(new Date(r.dueAt).getDay(), 1);
  assert.equal(new Date(r.dueAt).getDate(), 9);

  // "every weekday" typed on a Wednesday morning starts tomorrow, since 9am
  // today has already gone.
  const weekday = parse("standup every weekday");
  assert.equal(new Date(weekday.dueAt).getDay(), 4);

  // A repeat never starts in the past.
  assert.ok(parse("meds every day").dueAt > NOW.getTime());
});

test("priority and tags", () => {
  const r = parse("file report !! #work #urgent");
  assert.equal(r.title, "file report");
  assert.equal(r.priority, 2);
  assert.deepEqual(r.tags, ["work", "urgent"]);
  assert.equal(parse("thing !").priority, 1);
  assert.equal(parse("thing !!!").priority, 3);
  // An exclamation mark attached to a word is punctuation, not a priority.
  assert.equal(parse("call mom!").priority, 0);
  assert.equal(parse("call mom!").title, "call mom!");
});

test("everything at once", () => {
  const r = parse("call the pediatrician tomorrow at 9am every 3 months !! #health");
  assert.equal(r.title, "call the pediatrician");
  assert.equal(r.priority, 2);
  assert.deepEqual(r.tags, ["health"]);
  assert.deepEqual(r.repeat, { freq: "monthly", interval: 3 });
  assert.equal(r.hasTime, true);
  assert.equal(due(r).getHours(), 9);
  assert.equal(due(r).getDate(), 5);
});

test("unrecognised text is left in the title rather than guessed at", () => {
  const r = parse("read chapter 12 of the manual");
  assert.equal(r.dueAt, null);
  assert.ok(r.title.includes("chapter 12"));
  assert.ok(r.title.includes("manual"));
});

test("empty and whitespace input do not throw", () => {
  assert.equal(parse("").title, "");
  assert.equal(parse("   ").title, "");
  assert.equal(parseQuickAdd(null, { now: NOW }).title, "");
  assert.equal(parseQuickAdd(undefined, { now: NOW }).dueAt, null);
});

test("the all-day alert hour is configurable", () => {
  const r = parseQuickAdd("thing tomorrow", { now: NOW, allDayAlertHour: 7 });
  assert.equal(r.hasTime, false);
  assert.equal(new Date(r.dueAt).getHours(), 7);
});
