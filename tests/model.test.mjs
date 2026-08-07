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
