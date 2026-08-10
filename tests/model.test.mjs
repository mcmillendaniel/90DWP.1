/**
 * The reminders store: normalising, mutating, and querying.
 *
 * Run with:  TZ=America/New_York node --test "tests/*.test.mjs"
 *
 * state.js reads and writes localStorage at module scope, so the stub has to be
 * in place before it is imported — hence the dynamic import below.
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
  _store: new Map(),
  getItem(k){ return this._store.has(k) ? this._store.get(k) : null; },
  setItem(k, v){ this._store.set(k, String(v)); },
  removeItem(k){ this._store.delete(k); },
  clear(){ this._store.clear(); }
};

const { normalizeReminders, normalizeItem, normalizeList } = await import("../js/reminders/schema.js");
const model = await import("../js/reminders/model.js");
const { replaceState } = await import("../js/state.js");
const { pushSignature } = await import("../js/reminders/schedule.js");

const at = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

/** Each test starts from an empty store. */
function reset(){
  replaceState({ days: {}, settings: {}, reminders: null });
  return model.reminders();
}

// ------------------------------------------------------------- normalising

test("normalizeReminders always produces a usable store", () => {
  for(const junk of [null, undefined, 42, "nope", [], { lists: "x", items: 7 }]){
    const r = normalizeReminders(junk);
    assert.ok(Array.isArray(r.lists) && r.lists.length >= 1, "there is always at least one list");
    assert.ok(Array.isArray(r.items));
    assert.ok(r.settings.defaultListId, "the default list points at a real list");
    assert.ok(r.lists.some(l => l.id === r.settings.defaultListId));
  }
});

test("normalizeItem defaults and clamps every field", () => {
  const it = normalizeItem({ title: 1234, priority: 99, earlyMin: -5, tags: ["A", "a", 7, null], subtasks: "no" });
  assert.equal(it.title, "1234");
  assert.equal(it.priority, 0);
  assert.equal(it.earlyMin, 0);
  assert.deepEqual(it.tags, ["a"], "tags are lowercased and de-duplicated");
  assert.deepEqual(it.subtasks, []);
  assert.equal(it.dueAt, null);
  assert.ok(it.id);

  // A time, a repeat and an early alert mean nothing without a date.
  const dateless = normalizeItem({ hasTime: true, repeat: { freq: "daily" }, earlyMin: 30 });
  assert.equal(dateless.hasTime, false);
  assert.equal(dateless.repeat, null);
  assert.equal(dateless.earlyMin, 0);

  const dated = normalizeItem({ dueAt: at(2026, 3, 4), hasTime: true, repeat: { freq: "daily" }, earlyMin: 30 });
  assert.equal(dated.hasTime, true);
  assert.deepEqual(dated.repeat, { freq: "daily", interval: 1 });
  assert.equal(dated.earlyMin, 30);
});

test("an item whose list vanished is rehomed rather than lost", () => {
  const r = normalizeReminders({
    lists: [normalizeList({ id: "keep", name: "Keep" })],
    items: [normalizeItem({ id: "a", listId: "deleted-list", title: "orphan" })]
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].listId, "keep");
});

test("normalizeList rejects unknown colours and sorts", () => {
  const l = normalizeList({ name: "x", color: "chartreuse", sort: "vibes" });
  assert.equal(l.color, "blue");
  assert.equal(l.sort, "manual");
});

// ----------------------------------------------------------------- lists

test("lists can be created, renamed, reordered and deleted with their items", () => {
  reset();
  const work = model.createList({ name: "Work", icon: "💼", color: "purple" });
  const home = model.createList({ name: "Home", icon: "🏠", color: "green" });
  assert.equal(model.allLists().length, 3);

  model.updateList(work.id, { name: "Job" });
  assert.equal(model.getList(work.id).name, "Job");

  const first = model.allLists()[0].id;
  model.moveList(home.id, -1);
  assert.notEqual(model.allLists()[0].id, home.id, "moving up from the end does not jump to the front");

  model.createItem({ listId: work.id, title: "a" });
  model.createItem({ listId: work.id, title: "b" });
  const result = model.deleteList(work.id);
  assert.equal(result.ok, true);
  assert.equal(result.itemIds.length, 2, "the caller is told what to unqueue");
  assert.equal(model.allItems().length, 0);
  assert.equal(first !== null, true);
});

test("the last list cannot be deleted", () => {
  reset();
  const only = model.allLists()[0];
  const result = model.deleteList(only.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "last-list");
  assert.equal(model.allLists().length, 1);
});

// ----------------------------------------------------------------- items

test("completing a repeating reminder advances it instead of finishing it", () => {
  reset();
  const dueAt = at(2026, 3, 4, 9);
  const item = model.createItem({
    title: "meds", dueAt, hasTime: true, repeat: { freq: "daily", interval: 1 }
  });

  const first = model.toggleComplete(item.id, at(2026, 3, 4, 10));
  assert.equal(first.advanced, true);
  assert.equal(first.item.completed, false, "it stays open");
  assert.equal(new Date(first.item.dueAt).getDate(), 5);

  const second = model.toggleComplete(item.id, at(2026, 3, 5, 10));
  assert.equal(second.advanced, true);
  assert.equal(new Date(second.item.dueAt).getDate(), 6);
});

test("the last occurrence of a repeat completes for real", () => {
  reset();
  const item = model.createItem({
    title: "course",
    dueAt: at(2026, 3, 4, 9),
    hasTime: true,
    repeat: { freq: "daily", interval: 1, until: at(2026, 3, 4, 23) }
  });
  const result = model.toggleComplete(item.id, at(2026, 3, 4, 10));
  assert.equal(result.advanced, false);
  assert.equal(result.item.completed, true);
  assert.equal(result.item.repeat, null, "a finished series stops repeating");
  assert.ok(result.item.completedAt);
});

test("a one-off toggles both ways", () => {
  reset();
  const item = model.createItem({ title: "call bank" });
  const done = model.toggleComplete(item.id, 1000);
  assert.equal(done.item.completed, true);
  assert.equal(done.item.completedAt, 1000);
  const undone = model.toggleComplete(item.id, 2000);
  assert.equal(undone.item.completed, false);
  assert.equal(undone.item.completedAt, null);
});

test("rollForwardRepeats only moves occurrences whose day is over", () => {
  reset();
  const stale = model.createItem({
    title: "old", dueAt: at(2026, 3, 1, 9), hasTime: true, repeat: { freq: "daily", interval: 1 }
  });
  const earlierToday = model.createItem({
    title: "this morning", dueAt: at(2026, 3, 4, 8), hasTime: true, repeat: { freq: "daily", interval: 1 }
  });
  const oneOff = model.createItem({ title: "missed", dueAt: at(2026, 3, 1, 9), hasTime: true });

  const changed = model.rollForwardRepeats(at(2026, 3, 4, 10, 30));
  assert.equal(changed, 1, "only the stale repeat moves");
  assert.ok(model.getItem(stale.id).dueAt > at(2026, 3, 4, 10, 30));
  assert.equal(model.getItem(earlierToday.id).dueAt, at(2026, 3, 4, 8),
    "a reminder missed earlier today stays overdue and visible");
  assert.equal(model.getItem(oneOff.id).dueAt, at(2026, 3, 1, 9),
    "a one-off never rolls forward");
});

// --------------------------------------------------------------- queries

test("smart lists select the right items", () => {
  reset();
  const now = at(2026, 3, 4, 12);
  const overdue = model.createItem({ title: "overdue", dueAt: at(2026, 3, 1, 9), hasTime: true });
  const today = model.createItem({ title: "today", dueAt: at(2026, 3, 4, 17), hasTime: true });
  const later = model.createItem({ title: "later", dueAt: at(2026, 3, 20, 9), hasTime: true });
  const undated = model.createItem({ title: "undated" });
  const flagged = model.createItem({ title: "flagged", flagged: true });
  const done = model.createItem({ title: "done" });
  model.toggleComplete(done.id, now);

  const ids = (scope) => model.queryItems(scope, { now }).map(i => i.id);

  assert.deepEqual(new Set(ids("today")), new Set([overdue.id, today.id]),
    "Today includes overdue, so a missed item does not disappear");
  assert.deepEqual(new Set(ids("scheduled")), new Set([overdue.id, today.id, later.id]));
  assert.deepEqual(new Set(ids("all")), new Set([overdue.id, today.id, later.id, undated.id, flagged.id]));
  assert.deepEqual(ids("flagged"), [flagged.id]);
  assert.deepEqual(ids("completed"), [done.id]);
});

test("a list hides completed items unless asked", () => {
  reset();
  const listId = model.defaultListId();
  model.createItem({ listId, title: "open" });
  const done = model.createItem({ listId, title: "done" });
  model.toggleComplete(done.id, Date.now());

  assert.equal(model.queryItems(listId, { showCompleted: false }).length, 1);
  assert.equal(model.queryItems(listId, { showCompleted: true }).length, 2);
  // Completed items sink to the bottom whatever the sort.
  const both = model.queryItems(listId, { showCompleted: true, sort: "title" });
  assert.equal(both[both.length - 1].id, done.id);
});

test("sorting", () => {
  reset();
  const listId = model.defaultListId();
  const now = at(2026, 3, 4, 12);
  const b = model.createItem({ listId, title: "b", dueAt: at(2026, 3, 10, 9), priority: 1 });
  const a = model.createItem({ listId, title: "a", dueAt: at(2026, 3, 6, 9), priority: 3 });
  const c = model.createItem({ listId, title: "c" });

  assert.deepEqual(model.queryItems(listId, { sort: "dueDate", now }).map(i => i.id), [a.id, b.id, c.id],
    "undated items sort last, not first");
  assert.deepEqual(model.queryItems(listId, { sort: "title", now }).map(i => i.title), ["a", "b", "c"]);
  assert.equal(model.queryItems(listId, { sort: "priority", now })[0].id, a.id);
});

test("search covers titles, notes, tags and subtasks", () => {
  reset();
  const listId = model.defaultListId();
  model.createItem({ listId, title: "buy paint", notes: "eggshell white" });
  const tagged = model.createItem({ listId, title: "invoice", tags: ["work"] });
  const withSub = model.createItem({ listId, title: "trip" });
  model.addSubtask(withSub.id, "book flights");

  assert.equal(model.searchAll("paint").length, 1);
  assert.equal(model.searchAll("eggshell").length, 1);
  assert.equal(model.searchAll("work")[0].id, tagged.id);
  assert.equal(model.searchAll("flights")[0].id, withSub.id);
  assert.equal(model.searchAll("").length, 0, "an empty query matches nothing, not everything");
  assert.equal(model.searchAll("zzz").length, 0);
});

test("counts and tags reflect open items only", () => {
  reset();
  const listId = model.defaultListId();
  model.createItem({ listId, title: "one", tags: ["home"] });
  const done = model.createItem({ listId, title: "two", tags: ["home"] });
  model.toggleComplete(done.id, Date.now());

  const c = model.counts(Date.now());
  assert.equal(c.lists[listId], 1, "a list count excludes completed items");
  assert.equal(c.smart.completed, 1);
  assert.deepEqual(model.allTags(), [["home", 1]]);
});

test("groupByDate buckets overdue, today, tomorrow and beyond", () => {
  reset();
  const now = at(2026, 3, 4, 12);
  const items = [
    model.createItem({ title: "late", dueAt: at(2026, 3, 1, 9) }),
    model.createItem({ title: "now", dueAt: at(2026, 3, 4, 17) }),
    model.createItem({ title: "soon", dueAt: at(2026, 3, 5, 9) }),
    model.createItem({ title: "far", dueAt: at(2026, 4, 1, 9) }),
    model.createItem({ title: "none" })
  ];
  const groups = model.groupByDate(items, now);
  assert.deepEqual(groups.map(g => g.label).slice(0, 3), ["Overdue", "Today", "Tomorrow"]);
  assert.equal(groups[groups.length - 1].label, "No Date", "undated items sit at the bottom");
});

// -------------------------------------------------------------- subtasks

test("subtasks can be added, renamed, toggled and removed", () => {
  reset();
  const item = model.createItem({ title: "trip" });
  model.addSubtask(item.id, "passport");
  model.addSubtask(item.id, "tickets");
  assert.equal(model.getItem(item.id).subtasks.length, 2);

  const subId = model.getItem(item.id).subtasks[0].id;
  model.updateSubtask(item.id, subId, { done: true, title: "renew passport" });
  assert.equal(model.getItem(item.id).subtasks[0].done, true);
  assert.equal(model.getItem(item.id).subtasks[0].title, "renew passport");

  model.deleteSubtask(item.id, subId);
  assert.equal(model.getItem(item.id).subtasks.length, 1);
});

// ------------------------------------------------------- push signatures

test("the push signature changes only when delivery would change", () => {
  reset();
  const item = model.createItem({
    title: "meds", dueAt: at(2026, 3, 4, 9), hasTime: true, repeat: { freq: "daily", interval: 1 }
  });
  const base = pushSignature(model.getItem(item.id));

  // Flagging changes nothing about the notification.
  model.toggleFlag(item.id);
  assert.equal(pushSignature(model.getItem(item.id)), base);

  // Moving the time does.
  model.updateItem(item.id, { dueAt: at(2026, 3, 4, 10) });
  assert.notEqual(pushSignature(model.getItem(item.id)), base);

  // So does an early alert, and so does the title, which is the body text.
  const moved = pushSignature(model.getItem(item.id));
  model.updateItem(item.id, { earlyMin: 15 });
  assert.notEqual(pushSignature(model.getItem(item.id)), moved);
  const early = pushSignature(model.getItem(item.id));
  model.updateItem(item.id, { title: "take meds" });
  assert.notEqual(pushSignature(model.getItem(item.id)), early);

  // A completed or undated item has nothing to deliver.
  model.updateItem(item.id, { completed: true });
  assert.equal(pushSignature(model.getItem(item.id)), "off");
  model.updateItem(item.id, { completed: false, dueAt: null });
  assert.equal(pushSignature(model.getItem(item.id)), "off");
});

// ------------------------------------------------------------ round trip

test("a full export/import round trip preserves reminders", async () => {
  reset();
  const list = model.createList({ name: "Errands", icon: "🛒", color: "orange" });
  const item = model.createItem({
    listId: list.id, title: "milk", dueAt: at(2026, 3, 9, 17), hasTime: true,
    repeat: { freq: "weekly", interval: 1 }, priority: 2, tags: ["shop"]
  });
  model.addSubtask(item.id, "oat too");

  const { state } = await import("../js/state.js");
  const blob = JSON.parse(JSON.stringify(state));
  replaceState({ days: {}, settings: {}, reminders: null });
  assert.equal(model.allItems().length, 0);

  replaceState(blob);
  const restored = model.getItem(item.id);
  assert.ok(restored, "the reminder survives the round trip");
  assert.equal(restored.title, "milk");
  assert.equal(restored.priority, 2);
  assert.deepEqual(restored.tags, ["shop"]);
  assert.deepEqual(restored.repeat, { freq: "weekly", interval: 1 });
  assert.equal(restored.subtasks.length, 1);
  assert.equal(model.getList(list.id).name, "Errands");
});

// ------------------------------------------------------------ home agenda

/**
 * The Home tab's list. The logbook day these use runs 2026-03-04 04:00 to
 * 2026-03-05 04:00 — see dayBounds() in state.js.
 */
test("the home agenda shows today's reminders and nothing scheduled later", () => {
  reset();
  const now = at(2026, 3, 4, 8);
  const today = model.createItem({ title: "school run", dueAt: at(2026, 3, 4, 15), hasTime: true });
  const nextWeek = model.createItem({ title: "doctor", dueAt: at(2026, 3, 10, 9), hasTime: true });
  const undated = model.createItem({ title: "someday" });

  const ids = model.homeAgenda(now).map(e => e.item.id);
  assert.deepEqual(ids, [today.id], "only what is due today");
  assert.ok(!ids.includes(nextWeek.id), "a reminder set for next week waits for next week");
  assert.ok(!ids.includes(undated.id), "an undated reminder has no day to land on");
});

test("the home agenda keeps a reminder for the rest of the day once done", () => {
  reset();
  const item = model.createItem({ title: "meds", dueAt: at(2026, 3, 4, 9), hasTime: true });
  model.toggleComplete(item.id, at(2026, 3, 4, 9, 30));

  const laterToday = model.homeAgenda(at(2026, 3, 4, 22));
  assert.equal(laterToday.length, 1, "it stays visible after being checked off");
  assert.equal(laterToday[0].done, true);

  // 3:00am still belongs to the previous logbook day; 5:00am does not.
  assert.equal(model.homeAgenda(at(2026, 3, 5, 3)).length, 1);
  assert.equal(model.homeAgenda(at(2026, 3, 5, 5)).length, 0, "it clears when the day does");
});

test("a repeating reminder checked off today reads as done, not as tomorrow's", () => {
  reset();
  const item = model.createItem({
    title: "vitamins", dueAt: at(2026, 3, 4, 9), hasTime: true,
    repeat: { freq: "daily", interval: 1 }
  });
  model.toggleComplete(item.id, at(2026, 3, 4, 9, 5));

  const entries = model.homeAgenda(at(2026, 3, 4, 18));
  assert.equal(entries.length, 1, "it has rolled to tomorrow but today's is still shown");
  assert.equal(entries[0].done, true);
  assert.equal(entries[0].advanced, true, "the row knows not to show tomorrow's time as if it were due");
  assert.equal(new Date(entries[0].item.dueAt).getDate(), 5, "the item itself points at tomorrow");

  // Tomorrow it is back, unchecked.
  const tomorrow = model.homeAgenda(at(2026, 3, 5, 10));
  assert.equal(tomorrow.length, 1);
  assert.equal(tomorrow[0].done, false);
});

test("checking a daily reminder off twice in one day does not skip a day", () => {
  reset();
  const item = model.createItem({
    title: "vitamins", dueAt: at(2026, 3, 4, 9), hasTime: true,
    repeat: { freq: "daily", interval: 1 }
  });
  model.toggleComplete(item.id, at(2026, 3, 4, 9, 5));
  const again = model.toggleComplete(item.id, at(2026, 3, 4, 14));

  assert.equal(again.alreadyDone, true);
  assert.equal(new Date(again.item.dueAt).getDate(), 5, "still tomorrow, not the day after");

  // An hourly repeat is a different matter: a second tap is a second occurrence.
  const hourly = model.createItem({
    title: "stand up", dueAt: at(2026, 3, 4, 9), hasTime: true,
    repeat: { freq: "hourly", interval: 1 }
  });
  model.toggleComplete(hourly.id, at(2026, 3, 4, 9, 5));
  const second = model.toggleComplete(hourly.id, at(2026, 3, 4, 10, 5));
  assert.equal(second.advanced, true);
  assert.equal(new Date(second.item.dueAt).getHours(), 11);
});

test("the home agenda carries overdue reminders forward and sorts them first", () => {
  reset();
  const now = at(2026, 3, 4, 12);
  const later = model.createItem({ title: "pick up", dueAt: at(2026, 3, 4, 17), hasTime: true });
  const missed = model.createItem({ title: "call bank", dueAt: at(2026, 3, 2, 10), hasTime: true });
  const finished = model.createItem({ title: "email", dueAt: at(2026, 3, 4, 8), hasTime: true });
  model.toggleComplete(finished.id, at(2026, 3, 4, 8, 30));

  const entries = model.homeAgenda(now);
  assert.deepEqual(entries.map(e => e.item.id), [missed.id, later.id, finished.id],
    "overdue first, then by due time, with what is done at the bottom");
  assert.equal(entries[0].overdue, true);
  assert.equal(entries[2].done, true);
});

test("a reminder completed on an earlier day is gone from the agenda", () => {
  reset();
  const item = model.createItem({ title: "old task", dueAt: at(2026, 3, 2, 9), hasTime: true });
  model.toggleComplete(item.id, at(2026, 3, 2, 10));
  assert.equal(model.homeAgenda(at(2026, 3, 4, 12)).length, 0);
});

test("lastDoneAt is backfilled from an older stored blob", () => {
  const item = normalizeItem({ title: "x", completed: true, completedAt: 1700 });
  assert.equal(item.lastDoneAt, 1700, "items written before lastDoneAt existed still read as done");
  assert.equal(normalizeItem({ title: "x" }).lastDoneAt, null);
});
