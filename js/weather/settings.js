/**
 * Where the weather is being fetched for.
 *
 * Deliberately dependency-free, for the same reason reminders/schema.js is:
 * state.js normalises the settings blob on load and on import, and importing
 * the weather service from there would close a cycle (the service reads state).
 */

export const DEFAULT_WEATHER_SETTINGS = {
  /** Decimal degrees, or null when no location has been chosen yet. */
  lat: null,
  lon: null,
  /** Human label for the coordinates — "Charlotte, NC". Filled in by NWS. */
  label: ""
};

function coord(value, limit){
  // Number(null) and Number("") are both 0, and 0,0 is a real place in the Gulf
  // of Guinea — an unset location must not quietly become one.
  if(typeof value !== "number" && typeof value !== "string") return null;
  if(typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  if(!Number.isFinite(n) || Math.abs(n) > limit) return null;
  // Four decimals is ~11m, far past what any forecast grid resolves, and keeps
  // the cache key from churning on GPS jitter.
  return Math.round(n * 1e4) / 1e4;
}

export function normalizeWeatherSettings(raw){
  const base = (raw && typeof raw === "object") ? raw : {};
  const lat = coord(base.lat, 90);
  const lon = coord(base.lon, 180);
  // A half-set location is no location: both or neither.
  const paired = (lat === null || lon === null) ? { lat: null, lon: null } : { lat, lon };
  return {
    ...paired,
    label: String(base.label ?? "").slice(0, 80)
  };
}

/**
 * Parses what someone types into the coordinates field: "35.2271, -80.8431".
 * Returns null when it is not a usable pair.
 */
export function parseCoords(text){
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text || ""));
  if(!m) return null;
  const lat = coord(m[1], 90);
  const lon = coord(m[2], 180);
  if(lat === null || lon === null) return null;
  return { lat, lon };
}
