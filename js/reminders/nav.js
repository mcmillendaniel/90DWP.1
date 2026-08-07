/**
 * Where the reminders tab currently is.
 *
 * The app re-renders <main> wholesale on every action, so this sub-navigation
 * has to live outside the DOM. It is deliberately a tiny module of its own:
 * both the views and the action handlers read it, and importing it from either
 * direction would otherwise close a cycle.
 */

const DEFAULT = {
  /** "home" | "list" | "item" | "listEdit" */
  view: "home",
  /** A list id, or one of the smart-list ids. */
  scopeId: null,
  /** The reminder open in the detail editor. */
  itemId: null,
  /** The list open in the list editor, null when creating a new one. */
  editListId: null,
  /**
   * A list being composed but not yet created. Held here rather than written
   * straight to state so backing out of the editor leaves nothing behind.
   */
  draftList: null,
  /** Search text on the reminders home. */
  query: "",
  /** Per-visit toggle; not persisted, same as iOS. */
  showCompleted: false
};

export const nav = { ...DEFAULT };

export function goHome(){
  Object.assign(nav, DEFAULT);
}

export function openScope(scopeId){
  nav.view = "list";
  nav.scopeId = scopeId;
  nav.itemId = null;
  nav.showCompleted = scopeId === "completed";
}

export function openItem(itemId){
  nav.view = "item";
  nav.itemId = itemId;
}

export function openListEditor(listId = null){
  nav.view = "listEdit";
  nav.editListId = listId;
  nav.draftList = listId ? null : { name: "", icon: "📋", color: "blue" };
}

/** The back button: detail -> list, list -> home. */
export function goBack(){
  if(nav.view === "item" && nav.scopeId){ nav.view = "list"; nav.itemId = null; return; }
  if(nav.view === "listEdit" && nav.editListId && nav.scopeId){ nav.view = "list"; return; }
  goHome();
}
