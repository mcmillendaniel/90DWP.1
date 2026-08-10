/**
 * The two forecast providers, and nothing else. Each function does one fetch
 * and hands back parsed JSON; deciding what to do with a failure is the
 * service's job.
 *
 * ## Why these two
 *
 * **NWS (api.weather.gov)** is the primary. It is the National Weather Service's
 * own API — the same data every US forecast is ultimately derived from,
 * including the Weather Channel's. It is free, needs no key, sends
 * `Access-Control-Allow-Origin: *` so a static page can call it directly, and it
 * is the only source that carries official watches, warnings and advisories.
 *
 * **Open-Meteo** is the fallback, and the source of the UV index. NWS coverage
 * stops at the US and its territories, and its public API publishes no UV index
 * at all — so even on the NWS path this is called for that one number.
 *
 * Neither is contacted through the Cloudflare Worker: these are plain GETs with
 * no secrets, and routing them through the worker would only add a hop that can
 * fail. The service worker ignores cross-origin requests, so nothing here is
 * cached by it — the weather cache in service.js is the only one.
 */

const NWS_BASE = "https://api.weather.gov";
const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

/** Long enough for a cold cellular request, short enough not to hang a launch. */
const TIMEOUT_MS = 8000;

async function fetchJson(url, { accept = "application/json", timeoutMs = TIMEOUT_MS } = {}){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: accept },
      // Weather changes; never let an intermediary hand back yesterday's.
      cache: "no-store"
    });
    if(!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves coordinates to an NWS forecast grid. The answer is stable for a
 * given point, so the service caches it rather than re-asking every refresh.
 */
export function fetchNwsPoint(lat, lon){
  return fetchJson(`${NWS_BASE}/points/${lat},${lon}`, { accept: "application/geo+json" });
}

/**
 * Everything NWS has to say about today at this point.
 *
 * The three requests are independent, so they go out together; alerts are
 * allowed to fail on their own — a missing advisory should not cost the whole
 * banner its temperatures.
 */
export async function fetchNws(lat, lon, point){
  const props = point?.properties;
  if(!props?.forecast || !props?.forecastHourly) throw new Error("NWS point response carried no forecast URLs");

  const [forecast, hourly, alerts] = await Promise.all([
    fetchJson(props.forecast, { accept: "application/geo+json" }),
    fetchJson(props.forecastHourly, { accept: "application/geo+json" }),
    fetchJson(`${NWS_BASE}/alerts/active?point=${lat},${lon}`, { accept: "application/geo+json" })
      .catch((e) => { console.warn("[weather] alerts unavailable:", e); return null; })
  ]);

  return { points: point, forecast, hourly, alerts };
}

/**
 * Open-Meteo's daily and hourly blocks in US units, for the same day window.
 * `timezone=auto` makes its date strings local to the coordinates, which is
 * what summarizeOpenMeteo() matches against.
 */
export function fetchOpenMeteo(lat, lon){
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,precipitation_probability",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,weather_code,wind_speed_10m_max",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    // Today and tomorrow: the logbook day runs to 4:00am, so it spills over.
    forecast_days: "2"
  });
  return fetchJson(`${OPEN_METEO_BASE}?${params}`);
}

/**
 * The device's own position, once. Not watched — a forecast grid is miles
 * across, so tracking movement would burn battery to change nothing.
 */
export function locateDevice({ timeoutMs = 12000 } = {}){
  return new Promise((resolve, reject) => {
    if(!("geolocation" in navigator)){
      reject(new Error("This device has no location service."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? "Location permission was denied. Enter coordinates instead."
          : "Could not get a location fix."
      )),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 10 * 60 * 1000 }
    );
  });
}
