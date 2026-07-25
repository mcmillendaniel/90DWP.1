/** Pure-ish view functions. Each returns an HTML string for <main>. */
import { escapeHtml } from "./dom.js";
import { state, ensureDay, dayKey, fmtTime, buildSuggestions } from "./state.js";
import { pushEnvironment, getPushResult, getLastSubEndpoint } from "./push.js";

export function renderHome(){
  const d = ensureDay(dayKey());
  return `
    <section class="card">
      <h2 class="h2">Today</h2>
      <div class="small">Day resets at 4:00am</div>
    </section>
    <section class="card">
      <h2 class="h2">Events</h2>
      <div class="row">
        <button class="btn" data-action="event:imUp">I'm up</button>
        <button class="btn" data-action="event:babyUp">Baby up</button>
        <button class="btn" data-action="event:napStart">Nap start</button>
        <button class="btn" data-action="event:napEnd">Nap end</button>
      </div>
      <div class="small" style="margin-top:10px">
        I'm up: <b>${fmtTime(d.events.imUp)}</b> •
        Baby up: <b>${fmtTime(d.events.babyUp)}</b> •
        Nap start: <b>${fmtTime(d.events.napStart)}</b> •
        Nap end: <b>${fmtTime(d.events.napEnd)}</b>
      </div>
      <div class="small" style="margin-top:8px">Tap a logged event again to edit its time.</div>
    </section>
  `;
}

export function renderCheckoffs(){
  const d = ensureDay(dayKey());
  const rows = d.outcomes.map((txt, i) => `
      <div class="item">
        <div class="item-left">
          <div class="item-title">Outcome ${i + 1}</div>
          <div class="item-sub">${txt?.trim() ? escapeHtml(txt) : "—"}</div>
        </div>
        <label class="pill">
          <input type="checkbox" data-action="toggleOutcome:${i}" ${d.outcomesDone[i] ? "checked" : ""} /> Done
        </label>
      </div>
    `).join("");
  const suggestions = buildSuggestions();
  return `
    <section class="card">
      <h2 class="h2">Write your 3 Outcomes</h2>
      <div class="small">Keep each one under ~10 minutes.</div>
      <div class="list" style="margin-top:10px">
        ${[0, 1, 2].map(i => `
          <textarea class="input" rows="2" placeholder="Outcome ${i + 1}" data-action="editOutcome:${i}">${escapeHtml(d.outcomes[i] || "")}</textarea>
        `).join("")}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="saveOutcomes">Save outcomes</button>
        <button class="btn" data-action="applySuggestion">Quick add suggestion</button>
      </div>
      <div class="small" style="margin-top:10px">
        Suggestion: <b id="suggestionText">${escapeHtml(suggestions.current || "—")}</b>
      </div>
    </section>
    <section class="card">
      <h2 class="h2">Check off</h2>
      <div class="list">${rows}</div>
    </section>
  `;
}

export function renderMorning(){
  const d = ensureDay(dayKey());
  const entries = [
    ["movement", "Movement complete", d.morning.movement],
    ["shower", "Shower done", d.morning.shower],
    ["outcomesWritten", "Outcomes written", d.morning.outcomesWritten],
    ["meds", "Meds taken", d.morning.meds]
  ];
  return `
    <section class="card">
      <h2 class="h2">Morning Stack</h2>
      <div class="small">Buttons log a timestamp. Tap a logged item again to edit its time.</div>
      <div class="list" style="margin-top:10px">
        ${entries.map(([key, label, ts]) => `
          <div class="item">
            <div class="item-left">
              <div class="item-title">${label}</div>
              <div class="item-sub">${fmtTime(ts)}</div>
            </div>
            <button class="btn" style="flex:0 0 auto" data-action="morning:${key}">Log</button>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

export function renderHistory(){
  const keys = Object.keys(state.days).sort().slice(-7).reverse();
  const cards = keys.map(k => {
    const d = state.days[k];
    const done = (d.outcomesDone || []).filter(Boolean).length;
    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${escapeHtml(k)}</div>
          <div class="item-sub">Outcomes: ${done}/3 • I'm up: ${fmtTime(d.events?.imUp)} • Baby up: ${fmtTime(d.events?.babyUp)}</div>
        </div>
        <div class="pill">${done === 3 ? "✅" : done === 0 ? "—" : "…"}</div>
      </div>
    `;
  }).join("");
  return `
    <section class="card">
      <h2 class="h2">History (last 7 days)</h2>
      <div class="list">${cards || `<div class="small">No history yet.</div>`}</div>
    </section>
  `;
}

export function renderSettings(){
  const env = pushEnvironment();
  const yn = (v) => v ? "yes" : "no";
  const diagnostics = [
    ["Installed to Home Screen", yn(env.isStandalone)],
    ["Notification permission", env.permission],
    ["Push API available", yn(env.hasPush)],
    ["Service worker support", yn(env.hasSW)],
    ["Push endpoint", getLastSubEndpoint() || "none"]
  ];
  const result = getPushResult();
  const resultBlock = result
    ? `<div class="diag-result ${result.ok ? "diag-result--ok" : "diag-result--bad"}">
         <div class="item-title">Last test: ${result.ok ? "accepted" : "failed"} @ ${fmtTime(result.at)}</div>
         <div class="diag-result-msg">${escapeHtml(result.message)}</div>
       </div>`
    : "";
  const iosWarning = (env.isIOS && !env.isStandalone)
    ? `<div class="small" style="margin-top:10px;color:var(--red);font-weight:700">
         iOS requires this app to be added to the Home Screen and opened from
         that icon. Push cannot work in a Safari tab.
       </div>`
    : "";
  return `
    <section class="card">
      <h2 class="h2">Settings</h2>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Push Notifications</div>
          <div class="item-sub">${state.settings.pushEnabled ? "Enabled" : "Disabled"} (iPhone PWA)</div>
        </div>
        ${state.settings.pushEnabled
          ? `<button class="btn" style="flex:0 0 auto" data-action="push:disable">Disable</button>`
          : `<button class="btn" style="flex:0 0 auto" data-action="push:enable">Enable</button>`
        }
      </div>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Export</div>
          <div class="item-sub">Download JSON + CSV backup</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="export">Export</button>
      </div>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Import</div>
          <div class="item-sub">Restore from JSON</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="import">Import</button>
      </div>
      <div class="small" style="margin-top:10px">
        Device ID: <b>${escapeHtml(state.deviceId)}</b>
      </div>
    </section>
    <section class="card">
      <h2 class="h2">Notification diagnostics</h2>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Test local notification</div>
          <div class="item-sub">Skips the server. Checks permission + display.</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="test:local">Run</button>
      </div>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Test push round trip</div>
          <div class="item-sub">Asks the worker to send one in ~15s.</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="test:push">Run</button>
      </div>
      <div class="list" style="margin-top:10px">
        ${diagnostics.map(([label, value]) => `
          <div class="item">
            <div class="item-left"><div class="item-title">${label}</div></div>
            <div class="pill">${escapeHtml(value)}</div>
          </div>
        `).join("")}
      </div>
      ${resultBlock}
      ${iosWarning}
    </section>
  `;
}
