/**
 * HTML for the Reminders tab. Same contract as js/views.js: each function
 * returns a string that gets written into <main>, and every piece of
 * user-controlled text goes through escapeHtml().
 */

import { escapeHtml } from "../dom.js";
import { state } from "../state.js";
import {
  allLists, getList, getItem, queryItems, searchAll, counts, groupByDate,
  allTags, isOverdue, remindersSettings,
  SMART_LISTS, LIST_COLORS, LIST_ICONS, SORT_MODES, PRIORITY_LABELS, PRIORITY_MARKS
} from "./model.js";
import {
  REPEAT_PRESETS, repeatPresetId, repeatLabel, formatDueLabel,
  toDateInputValue, toTimeInputValue, WEEKDAY_SHORT
} from "./recur.js";
import { nav } from "./nav.js";

const EARLY_OPTIONS = [
  { min: 0, label: "At time of reminder" },
  { min: 5, label: "5 minutes before" },
  { min: 10, label: "10 minutes before" },
  { min: 15, label: "15 minutes before" },
  { min: 30, label: "30 minutes before" },
  { min: 60, label: "1 hour before" },
  { min: 120, label: "2 hours before" },
  { min: 1440, label: "1 day before" },
  { min: 2880, label: "2 days before" },
  { min: 10080, label: "1 week before" }
];

export function colorHex(colorId){
  return (LIST_COLORS.find(c => c.id === colorId) || LIST_COLORS[5]).hex;
}

/**
 * A reminder with a due date and push switched off looks like it will alert and
 * never does. Say so, once, where reminders are actually being made — but only
 * when there is something that would have alerted.
 */
function pushOffBanner(){
  if(state.settings.pushEnabled) return "";
  const dated = queryItems("scheduled").length;
  if(!dated) return "";
  return `
    <div class="rem-banner">
      Notifications are off, so these ${dated} dated reminder${dated === 1 ? "" : "s"}
      won't alert. Turn on Push Notifications in Settings.
    </div>
  `;
}

export function renderReminders(){
  switch(nav.view){
    case "list": return renderScope();
    case "item": return renderItemEditor();
    case "listEdit": return renderListEditor();
    default: return renderRemindersHome();
  }
}

/** The scope currently open, whether it is a real list or a smart one. */
function scopeMeta(scopeId){
  const smart = SMART_LISTS.find(s => s.id === scopeId);
  if(smart) return { name: smart.name, icon: smart.icon, color: smart.color, smart: true };
  const list = getList(scopeId);
  if(list) return { name: list.name, icon: list.icon, color: colorHex(list.color), smart: false, list };
  return null;
}

// -------------------------------------------------------------------- home

function renderRemindersHome(){
  const c = counts();
  const query = nav.query.trim();

  const tiles = SMART_LISTS.map(s => `
    <button class="rem-tile" data-action="rem:open:${s.id}">
      <span class="rem-tile-icon" style="background:${s.color}">${s.icon}</span>
      <span class="rem-tile-count">${c.smart[s.id]}</span>
      <span class="rem-tile-name">${escapeHtml(s.name)}</span>
    </button>
  `).join("");

  const lists = allLists().map((l, i, arr) => `
    <div class="item rem-list-row">
      <button class="rem-list-open" data-action="rem:open:${l.id}">
        <span class="rem-list-icon" style="background:${colorHex(l.color)}">${escapeHtml(l.icon)}</span>
        <span class="item-title">${escapeHtml(l.name)}</span>
      </button>
      <span class="pill">${c.lists[l.id] ?? 0}</span>
      <button class="rem-icon-btn" data-action="rem:moveList:${l.id}:-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
      <button class="rem-icon-btn" data-action="rem:moveList:${l.id}:1" ${i === arr.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
      <button class="rem-icon-btn" data-action="rem:editList:${l.id}" aria-label="Edit list">✎</button>
    </div>
  `).join("");

  const tags = allTags().slice(0, 12);
  const tagRow = tags.length ? `
    <section class="card">
      <h2 class="h2">Tags</h2>
      <div class="rem-tags">
        ${tags.map(([tag, n]) => `
          <button class="rem-tag" data-action="rem:searchTag:${encodeURIComponent(tag)}">#${escapeHtml(tag)} <span>${n}</span></button>
        `).join("")}
      </div>
    </section>
  ` : "";

  return `
    <section class="card">
      <input class="input" type="search" placeholder="Search all reminders"
             data-action="rem:search" data-action-kind="live"
             value="${escapeHtml(nav.query)}" />
      ${query ? renderSearchResults(query) : ""}
    </section>
    ${query ? "" : `
      ${pushOffBanner()}
      <div class="rem-tiles">${tiles}</div>
      <section class="card">
        <h2 class="h2">My Lists</h2>
        <div class="list">${lists}</div>
        <div class="row" style="margin-top:10px">
          <button class="btn" data-action="rem:newList">＋ Add List</button>
        </div>
      </section>
      ${tagRow}
    `}
  `;
}

function renderSearchResults(query){
  const found = searchAll(query);
  if(!found.length) return `<div class="small" style="margin-top:12px">No matches for “${escapeHtml(query)}”.</div>`;
  return `
    <div class="small" style="margin:12px 0 8px">${found.length} match${found.length === 1 ? "" : "es"}</div>
    <div class="list">${found.map(item => itemRow(item, { showList: true })).join("")}</div>
  `;
}

// -------------------------------------------------------------- list view

function renderScope(){
  const meta = scopeMeta(nav.scopeId);
  if(!meta){
    return `<section class="card"><div class="small">That list is gone.</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-action="rem:home">Back to lists</button></div></section>`;
  }

  const sort = meta.smart ? "dueDate" : meta.list.sort;
  const items = queryItems(nav.scopeId, { showCompleted: nav.showCompleted, sort });
  const grouped = (nav.scopeId === "scheduled" || nav.scopeId === "today");

  let body;
  if(!items.length){
    body = `<div class="rem-empty">Nothing here.</div>`;
  } else if(grouped){
    body = groupByDate(items).map(g => `
      <div class="rem-group">
        <div class="rem-group-label">${escapeHtml(g.label)}</div>
        <div class="list">${g.items.map(item => itemRow(item, { showList: true })).join("")}</div>
      </div>
    `).join("");
  } else {
    const ids = items.map(i => i.id);
    body = `<div class="list">${items.map((item, i) => itemRow(item, {
      showList: meta.smart,
      reorder: sort === "manual" && !meta.smart ? { index: i, total: ids.length } : null
    })).join("")}</div>`;
  }

  const controls = meta.smart ? "" : `
    <div class="rem-controls">
      <label class="small">Sort
        <select data-action="rem:sort" data-action-kind="change">
          ${SORT_MODES.map(s => `<option value="${s.id}" ${s.id === meta.list.sort ? "selected" : ""}>${s.label}</option>`).join("")}
        </select>
      </label>
      <button class="rem-chip ${nav.showCompleted ? "rem-chip--on" : ""}" data-action="rem:toggleShowCompleted">
        ${nav.showCompleted ? "Hide" : "Show"} Completed
      </button>
      <button class="rem-chip" data-action="rem:editList:${meta.list.id}">Edit List</button>
    </div>
  `;

  // Everything but Completed can be added to, as in iOS. A smart list decides
  // in actions.js what an item added there has to look like to belong.
  const composer = nav.scopeId === "completed" ? "" : `
    <section class="card">
      <input class="input" type="text" placeholder="＋ New Reminder — try “call mom tomorrow at 5pm”"
             data-action="rem:quickAdd" data-action-kind="submit" />
      <div class="small" style="margin-top:8px">
        Enter to add. Dates, times, <b>every week</b>, <b>#tags</b> and <b>!!!</b> priority are read from the text.
      </div>
    </section>
  `;

  return `
    <section class="card">
      <div class="rem-header">
        <button class="rem-icon-btn" data-action="rem:back" aria-label="Back">‹</button>
        <span class="rem-list-icon" style="background:${meta.color}">${escapeHtml(meta.icon)}</span>
        <h2 class="h2" style="margin:0;flex:1">${escapeHtml(meta.name)}</h2>
        <span class="pill">${items.filter(i => !i.completed).length}</span>
      </div>
      ${controls}
    </section>
    ${pushOffBanner()}
    ${composer}
    <section class="card">${body}</section>
  `;
}

function itemRow(item, opts = {}){
  const list = getList(item.listId);
  const overdue = isOverdue(item);
  const marks = PRIORITY_MARKS[item.priority];

  const sub = [];
  if(item.dueAt !== null){
    sub.push(`<span class="${overdue ? "rem-due-late" : "rem-due"}">${escapeHtml(formatDueLabel(item.dueAt, item.hasTime))}</span>`);
  }
  if(item.repeat) sub.push(`<span class="rem-meta">🔁 ${escapeHtml(repeatLabel(item.repeat))}</span>`);
  if(opts.showList && list) sub.push(`<span class="rem-meta">${escapeHtml(list.icon)} ${escapeHtml(list.name)}</span>`);
  if(item.notes.trim()) sub.push(`<span class="rem-meta">${escapeHtml(item.notes.trim().split("\n")[0].slice(0, 60))}</span>`);
  if(item.subtasks.length){
    const done = item.subtasks.filter(s => s.done).length;
    sub.push(`<span class="rem-meta">☑ ${done}/${item.subtasks.length}</span>`);
  }
  if(item.tags.length) sub.push(item.tags.map(t => `<span class="rem-meta rem-meta--tag">#${escapeHtml(t)}</span>`).join(" "));

  const reorder = opts.reorder ? `
    <button class="rem-icon-btn" data-action="rem:move:${item.id}:-1" ${opts.reorder.index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
    <button class="rem-icon-btn" data-action="rem:move:${item.id}:1" ${opts.reorder.index === opts.reorder.total - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
  ` : "";

  return `
    <div class="rem-row ${item.completed ? "rem-row--done" : ""}">
      <button class="rem-check ${item.completed ? "rem-check--on" : ""}"
              style="border-color:${list ? colorHex(list.color) : "#999"}"
              data-action="rem:toggle:${item.id}" aria-label="Complete">${item.completed ? "✓" : ""}</button>
      <button class="rem-row-open" data-action="rem:item:${item.id}">
        <span class="rem-row-title">${marks ? `<span class="rem-pri">${marks}</span>` : ""}${escapeHtml(item.title || "New Reminder")}</span>
        ${sub.length ? `<span class="rem-row-sub">${sub.join(" · ")}</span>` : ""}
      </button>
      ${reorder}
      <button class="rem-icon-btn ${item.flagged ? "rem-flag--on" : ""}" data-action="rem:flag:${item.id}" aria-label="Flag">${item.flagged ? "🚩" : "⚐"}</button>
    </div>
  `;
}

// ------------------------------------------------------------ item editor

function renderItemEditor(){
  const item = getItem(nav.itemId);
  if(!item){
    return `<section class="card"><div class="small">That reminder is gone.</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-action="rem:back">Back</button></div></section>`;
  }
  const hasDate = item.dueAt !== null;
  const id = item.id;

  const repeatId = repeatPresetId(item.repeat);
  const repeatSection = hasDate ? `
    <label class="rem-field">
      <span class="rem-field-label">Repeat</span>
      <select data-action="rem:set:${id}:repeat" data-action-kind="change">
        ${REPEAT_PRESETS.map(p => `<option value="${p.id}" ${p.id === repeatId ? "selected" : ""}>${p.label}</option>`).join("")}
        <option value="custom" ${repeatId === "custom" ? "selected" : ""}>Custom…</option>
      </select>
    </label>
    ${item.repeat ? renderRepeatDetail(item) : ""}
  ` : "";

  return `
    <section class="card">
      <div class="rem-header">
        <button class="rem-icon-btn" data-action="rem:back" aria-label="Back">‹</button>
        <h2 class="h2" style="margin:0;flex:1">Details</h2>
        <button class="rem-chip ${item.flagged ? "rem-chip--on" : ""}" data-action="rem:flag:${id}">
          ${item.flagged ? "🚩 Flagged" : "⚐ Flag"}
        </button>
      </div>

      <input class="input rem-title-input" type="text" placeholder="Title"
             data-action="rem:set:${id}:title" value="${escapeHtml(item.title)}" />
      <textarea class="input" rows="3" placeholder="Notes"
                data-action="rem:set:${id}:notes">${escapeHtml(item.notes)}</textarea>
      <input class="input" type="url" placeholder="URL"
             data-action="rem:set:${id}:url" value="${escapeHtml(item.url)}" />
      ${item.url.trim() ? `<div class="small" style="margin-top:6px"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open link</a></div>` : ""}
    </section>

    <section class="card">
      <h2 class="h2">When</h2>
      <div class="item">
        <div class="item-left"><div class="item-title">Date</div>
          <div class="item-sub">${hasDate ? escapeHtml(formatDueLabel(item.dueAt, item.hasTime)) : "No date — never alerts"}</div>
        </div>
        <button class="rem-switch ${hasDate ? "rem-switch--on" : ""}" data-action="rem:toggleDate:${id}" aria-label="Toggle date"></button>
      </div>
      ${hasDate ? `
        <label class="rem-field">
          <span class="rem-field-label">Day</span>
          <input type="date" value="${toDateInputValue(item.dueAt)}"
                 data-action="rem:set:${id}:date" data-action-kind="change" />
        </label>
        <div class="item">
          <div class="item-left"><div class="item-title">Time</div>
            <div class="item-sub">${item.hasTime ? "Alerts at the time below" : `All-day — alerts at ${remindersSettings().allDayAlertHour}:00`}</div>
          </div>
          <button class="rem-switch ${item.hasTime ? "rem-switch--on" : ""}" data-action="rem:toggleTime:${id}" aria-label="Toggle time"></button>
        </div>
        ${item.hasTime ? `
          <label class="rem-field">
            <span class="rem-field-label">Time</span>
            <input type="time" value="${toTimeInputValue(item.dueAt)}"
                   data-action="rem:set:${id}:time" data-action-kind="change" />
          </label>
        ` : ""}
        <label class="rem-field">
          <span class="rem-field-label">Alert</span>
          <select data-action="rem:set:${id}:early" data-action-kind="change">
            ${EARLY_OPTIONS.map(o => `<option value="${o.min}" ${o.min === item.earlyMin ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
        </label>
        ${repeatSection}
      ` : ""}
    </section>

    <section class="card">
      <h2 class="h2">Details</h2>
      <label class="rem-field">
        <span class="rem-field-label">List</span>
        <select data-action="rem:set:${id}:listId" data-action-kind="change">
          ${allLists().map(l => `<option value="${l.id}" ${l.id === item.listId ? "selected" : ""}>${escapeHtml(l.icon)} ${escapeHtml(l.name)}</option>`).join("")}
        </select>
      </label>
      <label class="rem-field">
        <span class="rem-field-label">Priority</span>
        <select data-action="rem:set:${id}:priority" data-action-kind="change">
          ${PRIORITY_LABELS.map((label, v) => `<option value="${v}" ${v === item.priority ? "selected" : ""}>${label}${PRIORITY_MARKS[v] ? ` (${PRIORITY_MARKS[v]})` : ""}</option>`).join("")}
        </select>
      </label>
      <label class="rem-field">
        <span class="rem-field-label">Tags</span>
        <input class="input" type="text" placeholder="work, errands"
               data-action="rem:set:${id}:tags" value="${escapeHtml(item.tags.join(", "))}" />
      </label>
    </section>

    <section class="card">
      <h2 class="h2">Subtasks</h2>
      <div class="list">
        ${item.subtasks.map(s => `
          <div class="rem-row">
            <button class="rem-check ${s.done ? "rem-check--on" : ""}"
                    data-action="rem:subToggle:${id}:${s.id}" aria-label="Complete subtask">${s.done ? "✓" : ""}</button>
            <input class="input rem-sub-input ${s.done ? "rem-row--done" : ""}" type="text" value="${escapeHtml(s.title)}"
                   data-action="rem:subTitle:${id}:${s.id}" />
            <button class="rem-icon-btn" data-action="rem:subDelete:${id}:${s.id}" aria-label="Delete subtask">✕</button>
          </div>
        `).join("") || `<div class="small">None yet.</div>`}
      </div>
      <input class="input" style="margin-top:10px" type="text" placeholder="＋ Add subtask"
             data-action="rem:subAdd:${id}" data-action-kind="submit" />
    </section>

    <section class="card">
      <div class="small">
        Created ${escapeHtml(new Date(item.createdAt).toLocaleString())}${item.completedAt ? ` · Completed ${escapeHtml(new Date(item.completedAt).toLocaleString())}` : ""}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="rem:toggle:${id}">${item.completed ? "Mark as Not Completed" : "Mark as Completed"}</button>
        <button class="btn rem-btn--danger" data-action="rem:delete:${id}">Delete Reminder</button>
      </div>
    </section>
  `;
}

function renderRepeatDetail(item){
  const r = item.repeat;
  const id = item.id;
  const custom = repeatPresetId(r) === "custom" || (r.freq === "weekly" && r.weekdays?.length);
  const weekdayChips = (r.freq === "weekly") ? `
    <div class="rem-weekdays">
      ${WEEKDAY_SHORT.map((label, dow) => `
        <button class="rem-chip ${r.weekdays?.includes(dow) ? "rem-chip--on" : ""}"
                data-action="rem:repeatDay:${id}:${dow}">${label}</button>
      `).join("")}
    </div>
  ` : "";

  return `
    <div class="rem-repeat-detail">
      <div class="small">${escapeHtml(repeatLabel(r))}</div>
      ${custom ? `
        <label class="rem-field">
          <span class="rem-field-label">Every</span>
          <input type="number" min="1" max="999" value="${r.interval}"
                 data-action="rem:set:${id}:repeatInterval" data-action-kind="change" />
        </label>
        <label class="rem-field">
          <span class="rem-field-label">Unit</span>
          <select data-action="rem:set:${id}:repeatFreq" data-action-kind="change">
            ${["hourly", "daily", "weekly", "monthly", "yearly"].map(f =>
              `<option value="${f}" ${f === r.freq ? "selected" : ""}>${f}</option>`).join("")}
          </select>
        </label>
      ` : ""}
      ${weekdayChips}
      <label class="rem-field">
        <span class="rem-field-label">End repeat</span>
        <input type="date" value="${r.until ? toDateInputValue(r.until) : ""}"
               data-action="rem:set:${id}:repeatUntil" data-action-kind="change" />
      </label>
      ${r.until ? `<button class="rem-chip" data-action="rem:clearUntil:${id}">Repeat forever</button>` : ""}
    </div>
  `;
}

// ------------------------------------------------------------ list editor

function renderListEditor(){
  const list = nav.editListId ? getList(nav.editListId) : null;
  // A list being created is edited as a draft in nav until Create is tapped.
  const draft = list || nav.draftList || { name: "", icon: "📋", color: "blue" };
  const { name, icon, color } = draft;
  const target = list ? list.id : "new";

  return `
    <section class="card">
      <div class="rem-header">
        <button class="rem-icon-btn" data-action="rem:back" aria-label="Back">‹</button>
        <h2 class="h2" style="margin:0;flex:1">${list ? "Edit List" : "New List"}</h2>
      </div>
      <input class="input" type="text" placeholder="List name" id="remListName"
             data-action="rem:listName:${target}" value="${escapeHtml(name)}" />

      <div class="small" style="margin-top:12px">Icon</div>
      <div class="rem-picker">
        ${LIST_ICONS.map(ic => `
          <button class="rem-icon-opt ${ic === icon ? "rem-icon-opt--on" : ""}"
                  data-action="rem:listIcon:${target}:${encodeURIComponent(ic)}">${ic}</button>
        `).join("")}
      </div>

      <div class="small" style="margin-top:12px">Color</div>
      <div class="rem-picker">
        ${LIST_COLORS.map(c => `
          <button class="rem-color-opt ${c.id === color ? "rem-color-opt--on" : ""}"
                  style="background:${c.hex}" data-action="rem:listColor:${target}:${c.id}"
                  aria-label="${c.id}"></button>
        `).join("")}
      </div>

      <div class="row" style="margin-top:14px">
        ${list
          ? `<button class="btn rem-btn--danger" data-action="rem:deleteList:${list.id}">Delete List</button>`
          : `<button class="btn" data-action="rem:createList">Create List</button>`}
        <button class="btn" data-action="rem:back">Done</button>
      </div>
      ${list ? `<div class="small" style="margin-top:10px">Deleting a list deletes its reminders and cancels their notifications.</div>` : ""}
    </section>
  `;
}
