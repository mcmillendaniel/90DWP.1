/**
 * The Home banner and the Settings card for weather.
 *
 * Same contract as the other view modules: a function in, an HTML string out,
 * every piece of text that came from a server through escapeHtml(). Reads only
 * the cached snapshot, so it never blocks a render on the network.
 */

import { escapeHtml } from "../dom.js";
import { dayKey } from "../state.js";
import { weatherSnapshot, isRefreshing } from "./service.js";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The date the banner shows is the logbook day's, not the wall clock's. */
function bannerDate(now = Date.now()){
  const [y, m, d] = dayKey(new Date(now)).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { dow: WEEKDAY_SHORT[date.getDay()], day: date.getDate() };
}

function formatHour(ts){
  return new Date(ts).toLocaleTimeString([], { hour: "numeric" });
}

function formatClock(ts){
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function temps(summary){
  const hi = summary.high === null ? "—" : `${summary.high}°`;
  const lo = summary.low === null ? "—" : `${summary.low}°`;
  return `${hi} / ${lo}`;
}

function summaryLines(summary, snap){
  const facts = [];
  if(summary.rainChance !== null) facts.push(`Rain ${summary.rainChance}%`);
  if(summary.peakAt !== null){
    // The high comes from the official daily forecast and the peak from the
    // hourly one, so they can differ by a degree. Repeating a number that
    // disagrees with the one two words to the left reads as a bug; the peak
    // temperature is only worth stating when it is genuinely different — which
    // is what an afternoon refresh, with the day's high already behind it,
    // produces.
    const peakTemp = summary.peakTemp;
    const notable = peakTemp !== null && (summary.high === null || Math.abs(summary.high - peakTemp) > 2);
    facts.push(`Peak ${notable ? `${peakTemp}° ` : ""}at ${escapeHtml(formatHour(summary.peakAt))}`);
  }

  const warnings = (summary.warnings || []).slice(0, 3).map(w => `
    <span class="wx-warn" title="${escapeHtml(w.detail || "")}">${escapeHtml(w.label)}</span>
  `).join("");

  const asOf = snap.fetchedAt
    ? `as of ${escapeHtml(formatClock(snap.fetchedAt))}${snap.stale ? " · out of date" : ""}`
    : "";

  return `
    <div class="wx-headline">
      <span class="wx-temps">${escapeHtml(temps(summary))}</span>
      ${summary.condition ? `<span class="wx-cond">${escapeHtml(summary.condition)}</span>` : ""}
    </div>
    ${facts.length ? `<div class="wx-facts">${facts.join(" · ")}</div>` : ""}
    ${warnings ? `<div class="wx-warns">${warnings}</div>` : ""}
    <div class="wx-foot">
      <span>${asOf}</span>
      <button class="wx-refresh" data-action="wx:refresh" aria-label="Refresh forecast">${isRefreshing() ? "…" : "↻"}</button>
    </div>
  `;
}

function statusBody(snap){
  switch(snap.status){
    case "no-location":
      return `
        <div class="wx-msg">No weather location set.</div>
        <div class="row" style="margin-top:8px">
          <button class="btn wx-btn" data-action="wx:locate">Use my location</button>
        </div>
      `;
    case "loading":
      return `<div class="wx-msg">Loading today's forecast…</div>`;
    default:
      return `
        <div class="wx-msg">${escapeHtml(snap.error || "The forecast could not be loaded.")}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn wx-btn" data-action="wx:refresh">Try again</button>
        </div>
      `;
  }
}

/** The banner that opens the Home tab: date on the left, the day's weather on the right. */
export function weatherBanner(now = Date.now()){
  const snap = weatherSnapshot(now);
  const { dow, day } = bannerDate(now);
  const body = snap.status === "ok" ? summaryLines(snap.summary, snap) : statusBody(snap);

  return `
    <section class="wx-banner">
      <div class="wx-date">
        <div class="wx-dow">${dow}</div>
        <div class="wx-day">${day}</div>
      </div>
      <div class="wx-body">${body}</div>
    </section>
  `;
}

/** The Settings section: where the forecast is for, and how to change it. */
export function weatherSettingsCard(){
  const snap = weatherSnapshot();
  const loc = snap.location;
  const placed = loc.lat !== null;
  const source = snap.summary?.source === "open-meteo" ? "Open-Meteo (NWS unavailable here)" : "National Weather Service";

  return `
    <section class="card">
      <h2 class="h2">Weather</h2>
      <div class="item">
        <div class="item-left">
          <div class="item-title">Location</div>
          <div class="item-sub">${placed
            ? escapeHtml(`${loc.label ? `${loc.label} · ` : ""}${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`)
            : "Not set — the Home banner has nothing to show"}</div>
        </div>
        <button class="btn" style="flex:0 0 auto" data-action="wx:locate">Use my location</button>
      </div>
      <label class="rem-field">
        <span class="rem-field-label">Coordinates</span>
        <input class="input" type="text" inputmode="decimal" placeholder="35.2271, -80.8431"
               data-action="wx:setCoords" data-action-kind="submit"
               value="${placed ? escapeHtml(`${loc.lat}, ${loc.lon}`) : ""}" />
      </label>
      <div class="small" style="margin-top:8px">
        Enter to save. Latitude, longitude — useful when location permission is
        off, or to pin the forecast to home rather than wherever the phone is.
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="wx:refresh">Refresh now</button>
        ${placed ? `<button class="btn rem-btn--danger" data-action="wx:clear">Clear location</button>` : ""}
      </div>
      <div class="small" style="margin-top:10px">
        Source: ${escapeHtml(source)}${snap.fetchedAt ? ` · updated ${escapeHtml(formatClock(snap.fetchedAt))}` : ""}
        ${snap.error ? `<br><span style="color:var(--red);font-weight:700">${escapeHtml(snap.error)}</span>` : ""}
      </div>
    </section>
  `;
}
