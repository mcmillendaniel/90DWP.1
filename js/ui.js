/** Controller: tab state, the render loop, event wiring, and action dispatch. */
import { $, toast } from "./dom.js";
import { saveState, ensureDay, dayKey, buildSuggestions } from "./state.js";
import { renderHome, renderCheckoffs, renderMorning, renderHistory, renderSettings } from "./views.js";
import { openWakeModal, pickWakeMessage } from "./wake.js";
import { openTimeEditFlow } from "./timepicker.js";
import { exportData, importData } from "./backup.js";
import {
  enablePushFlow, disablePushFlow, schedulePush,
  testLocalNotification, testPushRoundTrip
} from "./push.js";
import { renderReminders } from "./reminders/views.js";
import { handleReminderAction } from "./reminders/actions.js";
import { invalidateAllPushSignatures, reconcileReminderPushes } from "./reminders/schedule.js";
import { openItem, openScope } from "./reminders/nav.js";
import { getItem } from "./reminders/model.js";

let currentTab = "home";

const VIEWS = {
  home: renderHome,
  checkoffs: renderCheckoffs,
  morning: renderMorning,
  reminders: renderReminders,
  history: renderHistory,
  settings: renderSettings
};

export function setActiveTab(tab){
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  render();
}

/**
 * Opens the reminder a notification was about.
 *
 * iOS web push cannot put action buttons on a notification, so tapping it is
 * the only interaction available — it has to land on the right screen. Called
 * both with the launch URL (cold start via clients.openWindow) and with the
 * url the service worker posts back when the app is already open.
 *
 * Returns whether it recognised the url, so the caller knows to re-render.
 */
export function openReminderFromUrl(url){
  const match = /#reminder\/([A-Za-z0-9_-]+)/.exec(String(url || ""));
  if(!match) return false;
  const item = getItem(match[1]);
  if(!item){
    toast("That reminder no longer exists.");
    setActiveTab("reminders");
    return true;
  }
  openScope(item.listId);
  openItem(item.id);
  setActiveTab("reminders");
  return true;
}

export function computeTicker(){
  const d = ensureDay(dayKey());
  const done = d.outcomesDone.filter(Boolean).length;
  const ind = $("tickerIndicator");
  if(ind){
    if(done === 0) ind.style.background = "var(--red)";
    else if(done < 3) ind.style.background = "var(--yellow)";
    else ind.style.background = "var(--green)";
  }
  const texts = d.outcomes.map((t, i) => (t?.trim() ? `${i + 1}) ${t}` : `${i + 1}) [empty]`));
  return { done, total: 3, texts };
}

export function startTicker(){
  let idx = 0;
  setInterval(() => {
    const { texts } = computeTicker();
    const el = $("tickerText");
    if(el) el.textContent = texts[idx % texts.length];
    idx++;
  }, 3500);
}

export function render(){
  computeTicker();
  const main = $("main");
  if(!main) return;
  const focus = captureFocus();
  main.innerHTML = (VIEWS[currentTab] || renderHome)();
  wireActions();
  restoreFocus(focus);
}

/**
 * <main> is replaced wholesale on every render, which throws away whatever the
 * user had focused. Re-renders that happen while typing — search-as-you-type,
 * toggling a field next to an open input — would otherwise dismiss the iOS
 * keyboard mid-word. data-action is stable across renders, so it works as the
 * identity of the field to restore.
 */
function captureFocus(){
  const el = document.activeElement;
  if(!el || !el.matches?.("[data-action]")) return null;
  const main = $("main");
  if(!main || !main.contains(el)) return null;
  return {
    action: el.getAttribute("data-action"),
    start: el.selectionStart ?? null,
    end: el.selectionEnd ?? null
  };
}

function restoreFocus(focus){
  if(!focus) return;
  const el = $("main")?.querySelector(`[data-action="${CSS.escape(focus.action)}"]`);
  if(!el || typeof el.focus !== "function") return;
  el.focus({ preventScroll: true });
  if(focus.start !== null && typeof el.setSelectionRange === "function"){
    // Not every input type supports a selection range; a refusal is harmless.
    try { el.setSelectionRange(focus.start, focus.end); } catch {}
  }
}

/**
 * How an element reports an action, when data-action-kind does not say:
 *   click  (default) run the action and re-render
 *   input  free text — save on every keystroke, never re-render
 *   change committed choice (select, native date/time picker) — re-render
 * Explicit kinds add:
 *   live   like input, but re-renders and restores focus (search fields)
 *   submit run on Enter (quick-add and other composer fields)
 */
function actionKind(el){
  const explicit = el.dataset.actionKind;
  if(explicit) return explicit;
  if(el.tagName === "TEXTAREA") return "input";
  if(el.tagName === "SELECT") return "change";
  if(el.tagName === "INPUT"){
    const type = (el.type || "text").toLowerCase();
    if(["date", "time", "datetime-local", "number", "checkbox", "radio"].includes(type)) return "change";
    return "input";
  }
  return "click";
}

function wireActions(){
  document.querySelectorAll("[data-action]").forEach(el => {
    const act = el.getAttribute("data-action");
    const kind = actionKind(el);

    if(kind === "input" || kind === "live"){
      // Saves on every keystroke. "input" deliberately does not re-render:
      // that would destroy the element being typed into.
      el.oninput = async () => {
        try {
          await handleAction(act, el);
          saveState();
          if(kind === "live") render();
        } catch(e){
          console.error(e);
          toast("Something went wrong.");
        }
      };
      return;
    }

    if(kind === "submit"){
      el.onkeydown = (e) => {
        if(e.key !== "Enter") return;
        e.preventDefault();
        run(act, el);
      };
      return;
    }

    const handler = () => run(act, el);
    if(kind === "change") el.onchange = handler; else el.onclick = handler;
  });

  document.querySelectorAll(".tab").forEach(btn => {
    btn.onclick = () => setActiveTab(btn.dataset.tab);
  });
}

async function run(act, el){
  try {
    await handleAction(act, el);
    saveState();
    render();
  } catch(e){
    console.error(e);
    toast("Something went wrong.");
  }
}

async function handleAction(act, el){
  // The Reminders tab owns its whole namespace and handles its own navigation.
  if(act.startsWith("rem:")){
    if(handleReminderAction(act, el)) return;
    console.warn("[reminders] unhandled action:", act);
    return;
  }

  const d = ensureDay(dayKey());

  if(act.startsWith("editOutcome:")){
    const idx = Number(act.split(":")[1]);
    d.outcomes[idx] = el?.value ?? "";
    return;
  }

  if(act === "saveOutcomes"){ toast("Saved."); return; }

  if(act === "applySuggestion"){
    const sug = buildSuggestions().current;
    if(!sug){ toast("No suggestion found."); return; }
    let idx = d.outcomes.findIndex(x => !x?.trim());
    if(idx === -1) idx = 2;
    d.outcomes[idx] = sug;
    toast("Added suggestion.");
    return;
  }

  if(act.startsWith("toggleOutcome:")){
    const idx = Number(act.split(":")[1]);
    d.outcomesDone[idx] = !d.outcomesDone[idx];
    if(d.outcomesDone.every(Boolean)){
      toast("Day secured ✅🔥");
      await schedulePush(`celebrate-${dayKey()}`, "90DWP", "Day secured. Nice work.", Date.now() + 1000);
    }
    return;
  }

  if(act.startsWith("morning:")){
    const key = act.split(":")[1];
    if(d.morning[key]){
      const newTs = await openTimeEditFlow(d.morning[key]);
      if(newTs !== null){
        d.morning[key] = newTs;
        toast("Time updated.");
      }
      return;
    }
    d.morning[key] = Date.now();
    toast("Logged.");
    return;
  }

  if(act === "push:enable"){
    await enablePushFlow();
    // Nothing was queued server-side while push was off, so every reminder
    // needs re-queueing now rather than being skipped as unchanged.
    invalidateAllPushSignatures();
    await reconcileReminderPushes();
    return;
  }
  if(act === "push:disable"){ await disablePushFlow(); return; }
  if(act === "test:local"){ await testLocalNotification(); return; }
  if(act === "test:push"){ await testPushRoundTrip(); return; }
  if(act === "reminders:resync"){
    toast("Re-queueing reminders…");
    const summary = await reconcileReminderPushes({ force: true });
    toast(summary.disabled
      ? "Push is off — enable it first."
      : `${summary.queued} notification${summary.queued === 1 ? "" : "s"} queued.`);
    return;
  }
  if(act === "export"){ exportData(); return; }
  if(act === "import"){
    importData(() => {
      // An imported blob carries the other device's fingerprints, which say
      // nothing about what this device has queued.
      invalidateAllPushSignatures();
      reconcileReminderPushes().catch(e => console.error("[reminders] reconcile failed:", e));
      render();
    });
    return;
  }

  if(act.startsWith("event:")){
    const ev = act.split(":")[1];

    // Tapping an already-logged event opens the time picker instead of
    // overwriting the timestamp.
    if(d.events[ev]){
      const newTs = await openTimeEditFlow(d.events[ev]);
      if(newTs !== null){
        d.events[ev] = newTs;
        toast("Time updated.");
      }
      return;
    }

    d.events[ev] = Date.now();

    if(ev === "imUp"){
      const { message, subtext } = pickWakeMessage();
      openWakeModal({
        message,
        subtext,
        onDismiss: () => {
          setActiveTab("morning");
          toast("Morning stack. Keep it small.");
        }
      });
      return;
    }

    toast("Logged.");
    return;
  }
}
