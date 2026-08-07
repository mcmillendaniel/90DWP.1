/**
 * The reminders data model: lists, items, and the queries the views run
 * against them.
 *
 * Everything lives under `state.reminders` in the same localStorage blob as the
 * rest of the app, so export/import carries it along for free. Nothing here
 * touches the DOM or the network — mutations return the changed record and the
 * caller decides when to save, re-render, and reschedule.
 *
 * The record shapes and their normaliser live in schema.js, which state.js
 * imports directly. Their constants are re-exported here so the views and
 * actions have a single import to reach for.
 */

import { state, saveState } from "../state.js";
import {
  normalizeList, normalizeItem, normalizeSubtask, normalizeReminders, SMART_LISTS
} from "./schema.js";
import {
  rollForward, startOfDay, endOfDay, atTime, addDays, isSameDay, dayDiff
} from "./recur.js";

export {
  PRIORITY, PRIORITY_LABELS, PRIORITY_MARKS, LIST_COLORS, LIST_ICONS,
  SMART_LISTS, SORT_MODES, DEFAULT_REMINDER_SETTINGS, normalizeReminders
} from "./schema.js";

// ------------------------------------------------------------------ access

export function reminders(){
  if(!state.reminders) state.reminders = normalizeReminders(null);
  return state.reminders;
}

export function allItems(){ return reminders().items; }
export function allLists(){ return [...reminders().lists].sort((a, b) => a.order - b.order); }
export function remindersSettings(){ return reminders().settings; }

export function getList(id){ return reminders().lists.find(l => l.id === id) || null; }
export function getItem(id){ return reminders().items.find(i => i.id === id) || null; }

export function defaultListId(){
  const s = remindersSettings();
  return getList(s.defaultListId) ? s.defaultListId : (allLists()[0]?.id ?? null);
}

// ------------------------------------------------------------------- lists

export function createList({ name, icon, color } = {}){
  const lists = reminders().lists;
  const list = normalizeList({
    name: (name || "").trim() || "New List",
    icon: icon || "📋",
    color: color || "blue",
    order: lists.length ? Math.max(...lists.map(l => l.order)) + 1 : 0
  }, lists.length);
  lists.push(list);
  saveState();
  return list;
}

export function updateList(id, patch){
  const list = getList(id);
  if(!list) return null;
  Object.assign(list, normalizeList({ ...list, ...patch }, list.order));
  saveState();
  return list;
}

/**
 * Deletes a list and everything in it. Returns the ids of the deleted items so
 * the caller can cancel their queued notifications.
 */
export function deleteList(id){
  const r = reminders();
  if(r.lists.length <= 1) return { ok: false, itemIds: [], reason: "last-list" };
  const idx = r.lists.findIndex(l => l.id === id);
  if(idx === -1) return { ok: false, itemIds: [], reason: "missing" };
  const itemIds = r.items.filter(i => i.listId === id).map(i => i.id);
  r.items = r.items.filter(i => i.listId !== id);
  r.lists.splice(idx, 1);
  if(r.settings.defaultListId === id) r.settings.defaultListId = r.lists[0].id;
  saveState();
  return { ok: true, itemIds };
}

export function moveList(id, delta){
  const lists = allLists();
  const idx = lists.findIndex(l => l.id === id);
  const target = idx + delta;
  if(idx === -1 || target < 0 || target >= lists.length) return false;
  const [moved] = lists.splice(idx, 1);
  lists.splice(target, 0, moved);
  lists.forEach((l, i) => { l.order = i; });
  saveState();
  return true;
}

// ------------------------------------------------------------------- items

export function createItem(patch = {}){
  const r = reminders();
  const listId = (patch.listId && getList(patch.listId)) ? patch.listId : defaultListId();
  const siblings = r.items.filter(i => i.listId === listId);
  const item = normalizeItem({
    ...patch,
    listId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: siblings.length ? Math.min(...siblings.map(i => i.order)) - 1 : 0
  }, r.items.length);
  r.items.push(item);
  saveState();
  return item;
}

export function updateItem(id, patch){
  const r = reminders();
  const idx = r.items.findIndex(i => i.id === id);
  if(idx === -1) return null;
  const merged = normalizeItem({ ...r.items[idx], ...patch, updatedAt: Date.now() }, r.items[idx].order);
  r.items[idx] = merged;
  saveState();
  return merged;
}

export function deleteItem(id){
  const r = reminders();
  const idx = r.items.findIndex(i => i.id === id);
  if(idx === -1) return null;
  const [removed] = r.items.splice(idx, 1);
  saveState();
  return removed;
}

/**
 * Checking off a repeating reminder advances it to its next occurrence instead
 * of completing it, which is what iOS does — the item stays open, and the
 * completion is only recorded when the series itself has run out.
 *
 * Returns { item, advanced } so the caller can tell the two apart in the toast.
 */
export function toggleComplete(id, now = Date.now()){
  const item = getItem(id);
  if(!item) return null;

  if(!item.completed && item.repeat && item.dueAt !== null){
    const { dueAt, ended } = rollForward(item.dueAt, item.repeat, Math.max(now, item.dueAt));
    if(!ended){
      const updated = updateItem(id, { dueAt, completedAt: null, completed: false });
      return { item: updated, advanced: true };
    }
    // The end date has passed: this was the last occurrence, so it completes.
    const updated = updateItem(id, { repeat: null, completed: true, completedAt: now });
    return { item: updated, advanced: false };
  }

  const nowCompleted = !item.completed;
  const updated = updateItem(id, {
    completed: nowCompleted,
    completedAt: nowCompleted ? now : null
  });
  return { item: updated, advanced: false };
}

export function toggleFlag(id){
  const item = getItem(id);
  if(!item) return null;
  return updateItem(id, { flagged: !item.flagged });
}

export function moveItem(id, delta, scopeIds){
  const r = reminders();
  const ids = scopeIds.slice();
  const idx = ids.indexOf(id);
  const target = idx + delta;
  if(idx === -1 || target < 0 || target >= ids.length) return false;
  ids.splice(target, 0, ids.splice(idx, 1)[0]);
  ids.forEach((itemId, i) => {
    const item = r.items.find(x => x.id === itemId);
    if(item) item.order = i;
  });
  saveState();
  return true;
}

// ---------------------------------------------------------------- subtasks

export function addSubtask(itemId, title){
  const item = getItem(itemId);
  if(!item) return null;
  if(item.subtasks.length >= 100) return null;
  item.subtasks.push(normalizeSubtask({ title: String(title || "").trim() }));
  item.updatedAt = Date.now();
  saveState();
  return item;
}

export function updateSubtask(itemId, subId, patch){
  const item = getItem(itemId);
  const sub = item?.subtasks.find(s => s.id === subId);
  if(!sub) return null;
  Object.assign(sub, normalizeSubtask({ ...sub, ...patch }));
  item.updatedAt = Date.now();
  saveState();
  return item;
}

export function deleteSubtask(itemId, subId){
  const item = getItem(itemId);
  if(!item) return null;
  item.subtasks = item.subtasks.filter(s => s.id !== subId);
  item.updatedAt = Date.now();
  saveState();
  return item;
}

// ----------------------------------------------------------------- queries

export function isOverdue(item, now = Date.now()){
  return !item.completed && item.dueAt !== null && item.dueAt < now;
}

/** Whether an item belongs to one of the built-in smart lists. */
export function matchesSmartList(item, smartId, now = Date.now()){
  switch(smartId){
    case "today":
      // Overdue counts as today — an item you missed does not disappear.
      return !item.completed && item.dueAt !== null
        && (isSameDay(item.dueAt, now) || item.dueAt < now);
    case "scheduled":
      return !item.completed && item.dueAt !== null;
    case "all":
      return !item.completed;
    case "flagged":
      return !item.completed && item.flagged;
    case "completed":
      return item.completed;
    default:
      return false;
  }
}

export function isSmartList(id){ return SMART_LISTS.some(s => s.id === id); }

/**
 * The items a view should show, already sorted.
 *
 * @param {string} scopeId    a list id or a smart-list id
 * @param {object} [opts]     { showCompleted, sort, query, now }
 */
export function queryItems(scopeId, opts = {}){
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const smart = isSmartList(scopeId);
  const list = smart ? null : getList(scopeId);
  const sort = opts.sort || (list ? list.sort : "dueDate");
  const showCompleted = scopeId === "completed" ? true : !!opts.showCompleted;
  const query = String(opts.query || "").trim().toLowerCase();

  let items = allItems().filter(item => {
    if(smart){
      if(!matchesSmartList(item, scopeId, now)) return false;
    } else {
      if(item.listId !== scopeId) return false;
      if(item.completed && !showCompleted) return false;
    }
    if(query && !itemMatchesQuery(item, query)) return false;
    return true;
  });

  return sortItems(items, sort, now);
}

function itemMatchesQuery(item, query){
  if(item.title.toLowerCase().includes(query)) return true;
  if(item.notes.toLowerCase().includes(query)) return true;
  if(item.tags.some(t => t.includes(query))) return true;
  return item.subtasks.some(s => s.title.toLowerCase().includes(query));
}

export function sortItems(items, sort, now = Date.now()){
  const byDue = (a, b) => {
    // Undated items sort after dated ones rather than to the top.
    if(a.dueAt === null && b.dueAt === null) return a.order - b.order;
    if(a.dueAt === null) return 1;
    if(b.dueAt === null) return -1;
    return a.dueAt - b.dueAt;
  };
  const sorted = items.slice();
  switch(sort){
    case "dueDate": sorted.sort(byDue); break;
    case "creation": sorted.sort((a, b) => a.createdAt - b.createdAt); break;
    // Priority is stored ascending (3 = high), so high has to come first.
    case "priority": sorted.sort((a, b) => (b.priority - a.priority) || byDue(a, b)); break;
    case "title": sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
    default: sorted.sort((a, b) => a.order - b.order);
  }
  // Completed items always sink to the bottom, whatever the sort.
  return sorted.sort((a, b) => Number(a.completed) - Number(b.completed));
}

/** Search across every list, for the search field on the reminders home. */
export function searchAll(query, now = Date.now()){
  const q = String(query || "").trim().toLowerCase();
  if(!q) return [];
  return sortItems(allItems().filter(i => itemMatchesQuery(i, q)), "dueDate", now);
}

export function counts(now = Date.now()){
  const out = { lists: {}, smart: {} };
  for(const s of SMART_LISTS) out.smart[s.id] = 0;
  for(const l of reminders().lists) out.lists[l.id] = 0;
  for(const item of allItems()){
    for(const s of SMART_LISTS){
      if(matchesSmartList(item, s.id, now)) out.smart[s.id]++;
    }
    if(!item.completed && out.lists[item.listId] !== undefined) out.lists[item.listId]++;
  }
  return out;
}

/** Every tag in use, most-used first — the tag filter row on the home view. */
export function allTags(){
  const tally = new Map();
  for(const item of allItems()){
    if(item.completed) continue;
    for(const tag of item.tags) tally.set(tag, (tally.get(tag) || 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Groups a list of items into the date buckets the Today and Scheduled views
 * show. Undated items land in "No Date".
 */
export function groupByDate(items, now = Date.now()){
  const groups = new Map();
  const push = (key, label, item, rank) => {
    if(!groups.has(key)) groups.set(key, { key, label, rank, items: [] });
    groups.get(key).items.push(item);
  };
  for(const item of items){
    if(item.dueAt === null){ push("none", "No Date", item, 1e9); continue; }
    const diff = dayDiff(now, item.dueAt);
    if(diff < 0) push("overdue", "Overdue", item, -1);
    else if(diff === 0) push("today", "Today", item, 0);
    else if(diff === 1) push("tomorrow", "Tomorrow", item, 1);
    else {
      const key = `d${startOfDay(item.dueAt)}`;
      push(key, new Date(item.dueAt).toLocaleDateString([], {
        weekday: "long", month: "short", day: "numeric"
      }), item, diff);
    }
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

/**
 * Brings repeating reminders whose occurrence has already gone by up to their
 * next one, so a daily reminder shows tomorrow's date rather than a stale one
 * after the app has been closed for a while.
 *
 * Returns the number of items changed.
 */
export function rollForwardRepeats(now = Date.now()){
  let changed = 0;
  for(const item of allItems()){
    if(item.completed || !item.repeat || item.dueAt === null) continue;
    if(item.dueAt > now) continue;
    // A missed occurrence stays visible for the rest of its own day, the way an
    // overdue reminder does, and only rolls once that day is over.
    if(endOfDay(item.dueAt) > now) continue;
    const { dueAt, ended } = rollForward(item.dueAt, item.repeat, now);
    if(ended){
      updateItem(item.id, { repeat: null });
    } else if(dueAt !== item.dueAt){
      updateItem(item.id, { dueAt });
    } else {
      continue;
    }
    changed++;
  }
  return changed;
}

/** The default due date used when the editor turns a date on. */
export function defaultDueAt(now = Date.now()){
  return atTime(addDays(now, 1), remindersSettings().allDayAlertHour, 0);
}
