/**
 * The shape of the reminders data, and the normaliser that guarantees it.
 *
 * Kept free of any dependency on state.js so that normalizeState() can call
 * normalizeReminders() on load and on import. model.js layers the queries and
 * mutations on top and re-exports the constants defined here, so the rest of
 * the app only ever imports from model.js.
 *
 * Every field is defaulted and clamped: a blob written before reminders
 * existed, hand-edited, or imported from another device must not be able to
 * crash the first render.
 */

import { safeUUID } from "../uid.js";
import { normalizeRepeat } from "./recur.js";

/** Priority levels, matching the ! / !! / !!! of iOS Reminders. */
export const PRIORITY = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
export const PRIORITY_LABELS = ["None", "Low", "Medium", "High"];
export const PRIORITY_MARKS = ["", "!", "!!", "!!!"];

export const LIST_COLORS = [
  { id: "red", hex: "#d83a3a" },
  { id: "orange", hex: "#e07b39" },
  { id: "yellow", hex: "#d4a300" },
  { id: "green", hex: "#2e8b57" },
  { id: "teal", hex: "#2a9d8f" },
  { id: "blue", hex: "#2f6fd0" },
  { id: "purple", hex: "#7d5bbe" },
  { id: "pink", hex: "#d3577f" },
  { id: "brown", hex: "#8b6b4f" },
  { id: "gray", hex: "#6b7a72" }
];

export const LIST_ICONS = ["📋", "🏠", "💼", "🛒", "💊", "👶", "💪", "💰", "🎯", "📞", "🔧", "🎁", "📚", "✈️", "🍽️", "🐾"];

export const SMART_LISTS = [
  { id: "today", name: "Today", icon: "📅", color: "#2f6fd0" },
  { id: "scheduled", name: "Scheduled", icon: "🗓️", color: "#d83a3a" },
  { id: "all", name: "All", icon: "🗂️", color: "#6b7a72" },
  { id: "flagged", name: "Flagged", icon: "🚩", color: "#e07b39" },
  { id: "completed", name: "Completed", icon: "✅", color: "#2e8b57" }
];

export const SORT_MODES = [
  { id: "manual", label: "Manual" },
  { id: "dueDate", label: "Due Date" },
  { id: "creation", label: "Creation Date" },
  { id: "priority", label: "Priority" },
  { id: "title", label: "Title" }
];

export const DEFAULT_REMINDER_SETTINGS = {
  /** Hour a reminder with a date but no time alerts, as in iOS's All-Day setting. */
  allDayAlertHour: 9,
  defaultListId: null,
  showCompleted: false
};

const MAX_TITLE = 500;
const MAX_NOTES = 5000;
const MAX_SUBTASKS = 100;

export function normalizeList(raw, index = 0){
  const base = (raw && typeof raw === "object") ? raw : {};
  return {
    id: typeof base.id === "string" && base.id ? base.id : safeUUID(),
    name: String(base.name ?? "List").slice(0, 100) || "List",
    color: LIST_COLORS.some(c => c.id === base.color) ? base.color : "blue",
    icon: typeof base.icon === "string" && base.icon ? base.icon.slice(0, 8) : "📋",
    sort: SORT_MODES.some(s => s.id === base.sort) ? base.sort : "manual",
    order: Number.isFinite(base.order) ? Number(base.order) : index,
    createdAt: Number.isFinite(base.createdAt) ? base.createdAt : Date.now()
  };
}

export function normalizeSubtask(raw){
  const base = (raw && typeof raw === "object") ? raw : {};
  return {
    id: typeof base.id === "string" && base.id ? base.id : safeUUID(),
    title: String(base.title ?? "").slice(0, MAX_TITLE),
    done: !!base.done
  };
}

export function normalizeItem(raw, index = 0){
  const base = (raw && typeof raw === "object") ? raw : {};
  const dueAt = Number.isFinite(base.dueAt) ? Number(base.dueAt) : null;
  return {
    id: typeof base.id === "string" && base.id ? base.id : safeUUID(),
    listId: typeof base.listId === "string" ? base.listId : null,
    title: String(base.title ?? "").slice(0, MAX_TITLE),
    notes: String(base.notes ?? "").slice(0, MAX_NOTES),
    url: String(base.url ?? "").slice(0, 2000),
    dueAt,
    // A due time, a repeat and an early alert only mean anything when there is
    // a due date to hang them on.
    hasTime: dueAt !== null && !!base.hasTime,
    repeat: dueAt !== null ? normalizeRepeat(base.repeat) : null,
    earlyMin: dueAt !== null && Number.isFinite(base.earlyMin)
      ? Math.max(0, Math.min(10080, Math.floor(base.earlyMin)))
      : 0,
    priority: [0, 1, 2, 3].includes(base.priority) ? base.priority : 0,
    flagged: !!base.flagged,
    tags: Array.isArray(base.tags)
      ? [...new Set(base.tags.filter(t => typeof t === "string" && t).map(t => t.toLowerCase().slice(0, 50)))]
      : [],
    subtasks: Array.isArray(base.subtasks) ? base.subtasks.slice(0, MAX_SUBTASKS).map(normalizeSubtask) : [],
    completed: !!base.completed,
    completedAt: Number.isFinite(base.completedAt) ? base.completedAt : null,
    createdAt: Number.isFinite(base.createdAt) ? base.createdAt : Date.now(),
    updatedAt: Number.isFinite(base.updatedAt) ? base.updatedAt : Date.now(),
    order: Number.isFinite(base.order) ? Number(base.order) : index,
    /** Fingerprint of what was last handed to the push queue — see schedule.js. */
    pushSig: typeof base.pushSig === "string" ? base.pushSig : null
  };
}

export function normalizeReminders(raw){
  const base = (raw && typeof raw === "object") ? raw : {};

  const lists = (Array.isArray(base.lists) ? base.lists : []).map(normalizeList);
  if(!lists.length) lists.push(normalizeList({ name: "Reminders", icon: "📋", color: "blue" }, 0));

  const listIds = new Set(lists.map(l => l.id));
  const items = (Array.isArray(base.items) ? base.items : [])
    .map(normalizeItem)
    // An item whose list was deleted out from under it lands in the first list
    // rather than disappearing from every view.
    .map(it => (it.listId && listIds.has(it.listId)) ? it : { ...it, listId: lists[0].id });

  const settings = Object.assign({}, DEFAULT_REMINDER_SETTINGS, base.settings || {});
  if(!listIds.has(settings.defaultListId)) settings.defaultListId = lists[0].id;
  settings.allDayAlertHour = Math.max(0, Math.min(23, Math.floor(Number(settings.allDayAlertHour)) || 0));
  settings.showCompleted = !!settings.showCompleted;

  return { lists, items, settings };
}
