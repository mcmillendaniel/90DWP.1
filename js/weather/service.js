/**
 * Fetching, caching and refreshing the day's weather.
 *
 * The rest of the app never awaits this. render() reads whatever the last
 * successful fetch left behind — synchronously, from a cache that survives a
 * relaunch — and a refresh re-renders when it lands. A phone with no signal
 * still opens to this morning's forecast with an "as of" time on it rather than
 * to an empty box.
 *
 * The cache lives under its own localStorage key rather than in the app state
 * blob: it is derived data with an expiry, and it has no business in an export
 * that is meant to be a logbook.
 */

import { state, saveState, dayBounds } from "../state.js";
import { normalizeWeatherSettings } from "./settings.js";
import { fetchNwsPoint, fetchNws, fetchOpenMeteo, locateDevice } from "./sources.js";
import { summarizeNws, summarizeOpenMeteo, dailyUvIndex, isUsableSummary } from "./summary.js";

const CACHE_KEY = "90dwp_weather_v1";

/** How long a fetched summary is served without going back to the network. */
const FRESH_MS = 30 * 60 * 1000;

/** Coordinates closer together than this share a forecast; don't refetch. */
const SAME_PLACE_DEG = 0.02;

let cache = loadCache();
let inflight = null;
let lastError = "";

// ------------------------------------------------------------------- cache

function loadCache(){
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY));
    if(raw && typeof raw === "object" && raw.summary) return raw;
  } catch {}
  return null;
}

function writeCache(next){
  cache = next;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); }
  catch(e){ console.warn("[weather] could not cache summary:", e); }
}

/** The NWS grid lookup for a point never changes, so it is kept across days. */
function cachedPoint(lat, lon){
  return samePlace(cache, lat, lon) ? (cache.point || null) : null;
}

function samePlace(entry, lat, lon){
  return !!entry
    && Math.abs(entry.lat - lat) < SAME_PLACE_DEG
    && Math.abs(entry.lon - lon) < SAME_PLACE_DEG;
}

// ---------------------------------------------------------------- location

export function weatherLocation(){
  const current = normalizeWeatherSettings(state.settings.weather);
  state.settings.weather = current;
  return current;
}

export function hasWeatherLocation(){
  return weatherLocation().lat !== null;
}

export function setWeatherLocation({ lat, lon, label = "" }){
  state.settings.weather = normalizeWeatherSettings({ lat, lon, label });
  saveState();
  return state.settings.weather;
}

export function clearWeatherLocation(){
  state.settings.weather = normalizeWeatherSettings(null);
  saveState();
  writeCache(null);
  lastError = "";
}

/** Asks the device where it is, stores it, and fetches for the new point. */
export async function useDeviceLocation(){
  const { lat, lon } = await locateDevice();
  setWeatherLocation({ lat, lon, label: "" });
  writeCache(null);              // the old point's grid is no longer ours
  return refreshWeather({ force: true });
}

// ----------------------------------------------------------------- reading

/**
 * What the views render from. Never throws, never awaits, and always answers
 * with something the banner can put on screen.
 */
export function weatherSnapshot(now = Date.now()){
  const loc = weatherLocation();
  const { start } = dayBounds(new Date(now));

  if(loc.lat === null){
    return { status: "no-location", summary: null, fetchedAt: null, stale: false, error: "", location: loc };
  }

  const usable = cache && samePlace(cache, loc.lat, loc.lon) && isUsableSummary(cache.summary) ? cache : null;
  // A summary describes one logbook day. Once the day has turned over, what is
  // cached is yesterday's forecast, however recently it was fetched.
  const stale = !usable || usable.dayStart !== start || (now - usable.fetchedAt) > FRESH_MS;

  if(!usable){
    return {
      status: inflight ? "loading" : (lastError ? "error" : "loading"),
      summary: null, fetchedAt: null, stale: true, error: lastError, location: loc
    };
  }

  return {
    status: "ok",
    summary: usable.summary,
    fetchedAt: usable.fetchedAt,
    stale,
    error: lastError,
    location: loc
  };
}

export function isRefreshing(){ return inflight !== null; }

// --------------------------------------------------------------- refreshing

/**
 * Brings the cache up to date if it needs it.
 *
 * Resolves to true when the on-screen summary changed, so callers can re-render
 * only when there is something new to show. Concurrent calls share one fetch.
 */
export function refreshWeather({ force = false, now = Date.now() } = {}){
  const loc = weatherLocation();
  if(loc.lat === null) return Promise.resolve(false);
  if(inflight) return inflight;

  const snap = weatherSnapshot(now);
  if(!force && snap.status === "ok" && !snap.stale) return Promise.resolve(false);

  inflight = fetchSummary(loc.lat, loc.lon, now)
    .then((entry) => {
      lastError = "";
      writeCache(entry);
      // NWS knows the nearest town; keep it as the label so Settings can show
      // where the forecast is actually for.
      if(entry.summary.place && entry.summary.place !== loc.label){
        setWeatherLocation({ lat: loc.lat, lon: loc.lon, label: entry.summary.place });
      }
      return true;
    })
    .catch((e) => {
      console.error("[weather] refresh failed:", e);
      lastError = describeError(e);
      return false;
    })
    .finally(() => { inflight = null; });

  return inflight;
}

async function fetchSummary(lat, lon, now){
  const { start, end } = dayBounds(new Date(now));
  const opts = { now, dayStart: start, dayEnd: end };

  // Open-Meteo goes out alongside NWS rather than after it: on the happy path
  // it supplies the UV index NWS has no field for, and on the unhappy path it
  // is already in flight to take over.
  const openMeteo = fetchOpenMeteo(lat, lon).catch((e) => {
    console.warn("[weather] open-meteo unavailable:", e);
    return null;
  });

  let point = cachedPoint(lat, lon);
  try {
    if(!point) point = await fetchNwsPoint(lat, lon);
    const raw = await fetchNws(lat, lon, point);
    const summary = summarizeNws({ ...raw, uvIndex: dailyUvIndex(await openMeteo, start) }, opts);
    if(!isUsableSummary(summary)) throw new Error("NWS answered with nothing usable");
    return { lat, lon, point, dayStart: start, fetchedAt: now, summary };
  } catch(e){
    const payload = await openMeteo;
    if(!payload) throw e;
    console.warn("[weather] falling back to open-meteo:", e);
    const summary = summarizeOpenMeteo(payload, opts);
    if(!isUsableSummary(summary)) throw e;
    // The point is not carried forward: it may be exactly what failed.
    return { lat, lon, point: null, dayStart: start, fetchedAt: now, summary };
  }
}

function describeError(e){
  const msg = String(e?.message || e || "");
  if(/abort/i.test(msg)) return "The forecast request timed out.";
  if(/failed to fetch|networkerror|load failed/i.test(msg)) return "No connection to the forecast service.";
  return msg.slice(0, 160) || "The forecast could not be loaded.";
}
