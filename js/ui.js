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

let currentTab = "home";

const VIEWS = {
  home: renderHome,
  checkoffs: renderCheckoffs,
  morning: renderMorning,
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
  main.innerHTML = (VIEWS[currentTab] || renderHome)();
  wireActions();
}

function wireActions(){
  document.querySelectorAll("[data-action]").forEach(el => {
    const act = el.getAttribute("data-action");

    // Outcome textareas save on input and must not trigger a re-render, which
    // would blow away the element the user is typing into.
    if(el.tagName === "TEXTAREA"){
      el.oninput = () => {
        const idx = Number(act.split(":")[1]);
        ensureDay(dayKey()).outcomes[idx] = el.value;
        saveState();
      };
      return;
    }

    el.onclick = async () => {
      try {
        await handleAction(act);
        saveState();
        render();
      } catch(e){
        console.error(e);
        toast("Something went wrong.");
      }
    };
  });

  document.querySelectorAll(".tab").forEach(btn => {
    btn.onclick = () => setActiveTab(btn.dataset.tab);
  });
}

async function handleAction(act){
  const d = ensureDay(dayKey());

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

  if(act === "push:enable"){ await enablePushFlow(); return; }
  if(act === "push:disable"){ await disablePushFlow(); return; }
  if(act === "test:local"){ await testLocalNotification(); return; }
  if(act === "test:push"){ await testPushRoundTrip(); return; }
  if(act === "export"){ exportData(); return; }
  if(act === "import"){ importData(() => render()); return; }

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
