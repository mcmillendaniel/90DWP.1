/**
 * Action dispatch for the Reminders tab.
 *
 * ui.js hands every `rem:*` action here. Returns true when the action was
 * recognised, so an unknown one still falls through to the generic handler
 * instead of being swallowed.
 *
 * Anything that changes when or whether a reminder alerts ends with a call to
 * scheduleReconcile(), which debounces the Worker round-trips.
 */

import { toast } from "../dom.js";
import { saveState } from "../state.js";
import {
  createItem, updateItem, deleteItem, toggleComplete, toggleFlag, moveItem,
  createList, updateList, deleteList, moveList, getItem, getList, queryItems,
  addSubtask, updateSubtask, deleteSubtask, remindersSettings, defaultDueAt,
  isSmartList, defaultListId
} from "./model.js";
import {
  REPEAT_PRESETS, normalizeRepeat, atTime, fromDateInputValue, fromTimeInputValue,
  formatDueLabel, repeatLabel
} from "./recur.js";
import { parseQuickAdd } from "./parse.js";
import { scheduleReconcile, cancelRemindersPushes } from "./schedule.js";
import { nav, goHome, goBack, openScope, openItem, openListEditor } from "./nav.js";

/**
 * @param {string} act  the full data-action string
 * @param {Element} el  the element that fired it, for reading .value
 * @returns {boolean}   whether this module handled the action
 */
export function handleReminderAction(act, el){
  if(!act.startsWith("rem:")) return false;
  const parts = act.split(":");
  const verb = parts[1];

  switch(verb){
    // ---- navigation ------------------------------------------------------
    case "home": goHome(); return true;
    case "back": goBack(); return true;
    case "open": openScope(parts[2]); return true;
    case "item": openItem(parts[2]); return true;

    case "search":
      nav.query = el?.value ?? "";
      return true;

    case "searchTag":
      nav.query = decodeURIComponent(parts[2] || "");
      goHomeKeepingQuery(nav.query);
      return true;

    case "sort": {
      const list = getList(nav.scopeId);
      if(list) updateList(list.id, { sort: el?.value });
      return true;
    }

    case "toggleShowCompleted":
      nav.showCompleted = !nav.showCompleted;
      return true;

    // ---- items -----------------------------------------------------------
    case "quickAdd": return quickAdd(el);

    case "toggle": {
      const result = toggleComplete(parts[2]);
      if(!result) return true;
      if(result.advanced){
        toast(`Next: ${formatDueLabel(result.item.dueAt, result.item.hasTime)}`);
      } else {
        toast(result.item.completed ? "Completed ✅" : "Marked not completed");
      }
      scheduleReconcile();
      return true;
    }

    case "flag": {
      const item = toggleFlag(parts[2]);
      if(item) toast(item.flagged ? "Flagged 🚩" : "Unflagged");
      return true;
    }

    case "move": {
      const scopeItems = queryItems(nav.scopeId, { showCompleted: nav.showCompleted, sort: "manual" });
      moveItem(parts[2], Number(parts[3]), scopeItems.map(i => i.id));
      return true;
    }

    case "delete": {
      const removed = deleteItem(parts[2]);
      if(removed){
        cancelRemindersPushes([removed.id]).catch(e => console.error("[reminders] cancel failed:", e));
        toast("Reminder deleted");
      }
      goBack();
      return true;
    }

    case "set": return setField(parts[2], parts[3], el);

    case "toggleDate": {
      const item = getItem(parts[2]);
      if(!item) return true;
      if(item.dueAt === null){
        updateItem(item.id, { dueAt: defaultDueAt(), hasTime: false });
      } else {
        // Clearing the date clears everything that depends on one.
        updateItem(item.id, { dueAt: null, hasTime: false, repeat: null, earlyMin: 0 });
      }
      scheduleReconcile();
      return true;
    }

    case "toggleTime": {
      const item = getItem(parts[2]);
      if(!item || item.dueAt === null) return true;
      if(item.hasTime){
        // Back to all-day: the alert falls to the configured all-day hour.
        updateItem(item.id, { hasTime: false, dueAt: atTime(item.dueAt, remindersSettings().allDayAlertHour, 0) });
      } else {
        updateItem(item.id, { hasTime: true });
      }
      scheduleReconcile();
      return true;
    }

    case "repeatDay": return toggleRepeatWeekday(parts[2], Number(parts[3]));

    case "clearUntil": {
      const item = getItem(parts[2]);
      if(item?.repeat){
        const { until, ...rest } = item.repeat;
        updateItem(item.id, { repeat: rest });
        scheduleReconcile();
      }
      return true;
    }

    // ---- subtasks --------------------------------------------------------
    case "subAdd": {
      const title = (el?.value || "").trim();
      if(!title){ toast("Type a subtask first."); return true; }
      addSubtask(parts[2], title);
      if(el) el.value = "";
      scheduleReconcile();
      return true;
    }
    case "subToggle": {
      const item = getItem(parts[2]);
      const sub = item?.subtasks.find(s => s.id === parts[3]);
      if(sub) updateSubtask(parts[2], parts[3], { done: !sub.done });
      return true;
    }
    case "subTitle":
      updateSubtask(parts[2], parts[3], { title: el?.value ?? "" });
      return true;
    case "subDelete":
      deleteSubtask(parts[2], parts[3]);
      scheduleReconcile();
      return true;

    // ---- lists -----------------------------------------------------------
    case "newList": openListEditor(null); return true;
    case "editList": openListEditor(parts[2]); return true;

    case "createList": {
      const draft = nav.draftList || {};
      const list = createList(draft);
      toast(`“${list.name}” created`);
      openScope(list.id);
      return true;
    }

    case "listName": return setListField(parts[2], "name", el?.value ?? "");
    case "listIcon": return setListField(parts[2], "icon", decodeURIComponent(parts[3] || "📋"));
    case "listColor": return setListField(parts[2], "color", parts[3]);

    case "moveList":
      moveList(parts[2], Number(parts[3]));
      return true;

    case "deleteList": {
      const result = deleteList(parts[2]);
      if(!result.ok){
        toast(result.reason === "last-list" ? "Keep at least one list." : "List not found.");
        return true;
      }
      cancelRemindersPushes(result.itemIds).catch(e => console.error("[reminders] cancel failed:", e));
      toast(`List deleted (${result.itemIds.length} reminder${result.itemIds.length === 1 ? "" : "s"})`);
      goHome();
      return true;
    }

    default:
      return false;
  }
}

function goHomeKeepingQuery(query){
  goHome();
  nav.query = query;
}

function quickAdd(el){
  const raw = (el?.value || "").trim();
  if(!raw){ toast("Type a reminder first."); return true; }

  const parsed = parseQuickAdd(raw, { allDayAlertHour: remindersSettings().allDayAlertHour });
  if(!parsed.title){ toast("That parsed to an empty title."); return true; }

  // A smart list is a query, not a place. An item added from one has to land in
  // a real list, and has to come out matching the query it was added from —
  // otherwise it vanishes the moment it is created.
  const smart = isSmartList(nav.scopeId);
  const listId = smart ? defaultListId() : nav.scopeId;
  let dueAt = parsed.dueAt;
  if(dueAt === null && (nav.scopeId === "today" || nav.scopeId === "scheduled")){
    dueAt = nav.scopeId === "today"
      ? atTime(Date.now(), remindersSettings().allDayAlertHour, 0)
      : defaultDueAt();
  }

  const item = createItem({
    listId,
    title: parsed.title,
    dueAt,
    hasTime: parsed.hasTime,
    repeat: parsed.repeat,
    priority: parsed.priority,
    tags: parsed.tags,
    flagged: nav.scopeId === "flagged"
  });

  if(el) el.value = "";
  const bits = [];
  if(item.dueAt !== null) bits.push(formatDueLabel(item.dueAt, item.hasTime));
  if(item.repeat) bits.push(repeatLabel(item.repeat));
  toast(bits.length ? `Added — ${bits.join(", ")}` : "Added");
  scheduleReconcile();
  return true;
}

function setField(id, field, el){
  const item = getItem(id);
  if(!item) return true;
  const value = el?.value ?? "";
  let reschedule = true;

  switch(field){
    case "title": updateItem(id, { title: value }); break;
    case "notes": updateItem(id, { notes: value }); break;
    case "url": updateItem(id, { url: value }); reschedule = false; break;
    case "listId": updateItem(id, { listId: value }); break;
    case "priority": updateItem(id, { priority: Number(value) }); break;
    case "early": updateItem(id, { earlyMin: Number(value) }); break;

    case "tags":
      updateItem(id, {
        tags: value.split(/[,\s]+/).map(t => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean)
      });
      reschedule = false;
      break;

    case "date": {
      const next = fromDateInputValue(value, item.dueAt ?? Date.now());
      if(next === null){ toast("Pick a valid date."); return true; }
      updateItem(id, { dueAt: next });
      break;
    }

    case "time": {
      const next = fromTimeInputValue(value, item.dueAt ?? Date.now());
      if(next === null){ toast("Pick a valid time."); return true; }
      updateItem(id, { dueAt: next, hasTime: true });
      break;
    }

    case "repeat": {
      if(value === "custom"){
        // Seed a custom rule from whatever is already set, so the extra
        // controls have something coherent to show.
        updateItem(id, { repeat: normalizeRepeat(item.repeat || { freq: "weekly", interval: 2 }) });
        break;
      }
      const preset = REPEAT_PRESETS.find(p => p.id === value);
      updateItem(id, { repeat: preset ? preset.rule : null });
      break;
    }

    case "repeatInterval": {
      if(!item.repeat) return true;
      updateItem(id, { repeat: { ...item.repeat, interval: Number(value) } });
      break;
    }

    case "repeatFreq": {
      if(!item.repeat) return true;
      const next = { ...item.repeat, freq: value };
      // Weekday selection only means anything for a weekly rule.
      if(value !== "weekly") delete next.weekdays;
      updateItem(id, { repeat: next });
      break;
    }

    case "repeatUntil": {
      if(!item.repeat) return true;
      const until = value ? fromDateInputValue(value, item.dueAt ?? Date.now()) : null;
      const next = { ...item.repeat };
      if(until === null) delete next.until; else next.until = until;
      updateItem(id, { repeat: next });
      break;
    }

    default:
      return false;
  }

  if(reschedule) scheduleReconcile();
  return true;
}

function toggleRepeatWeekday(id, dow){
  const item = getItem(id);
  if(!item?.repeat) return true;
  const current = new Set(item.repeat.weekdays || []);
  if(current.has(dow)) current.delete(dow); else current.add(dow);
  const weekdays = [...current].sort((a, b) => a - b);
  const next = { ...item.repeat, freq: "weekly" };
  // An empty selection is not a rule; fall back to a plain weekly repeat.
  if(weekdays.length) next.weekdays = weekdays; else delete next.weekdays;
  updateItem(id, { repeat: next });
  scheduleReconcile();
  return true;
}

function setListField(target, field, value){
  if(target === "new"){
    if(!nav.draftList) nav.draftList = { name: "", icon: "📋", color: "blue" };
    nav.draftList[field] = value;
    return true;
  }
  updateList(target, { [field]: value });
  saveState();
  return true;
}
