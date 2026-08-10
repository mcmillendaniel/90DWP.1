/**
 * Turning raw forecast payloads into the one-line summary the Home banner
 * shows.
 *
 * Everything here is pure: it takes already-fetched JSON and a day window, and
 * returns a plain object. No fetching, no DOM, no clock reads except the `now`
 * that is passed in — which is what makes it testable without a network (see
 * tests/weather.test.mjs).
 *
 * The summary shape:
 *   {
 *     source     "nws" | "open-meteo"
 *     place      "Charlotte, NC" or ""
 *     high, low  °F, or null when the payload did not carry them
 *     condition  "Partly Sunny"
 *     rainChance 0-100, or null
 *     peakTemp   °F at the warmest forecast hour of the day
 *     peakAt     epoch ms of that hour, or null
 *     uvIndex    the day's max UV index, or null
 *     warnings   [{ id, label, detail }] — official alerts first
 *   }
 */

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

/** WMO weather codes, for the Open-Meteo fallback. */
const WMO = new Map([
  [0, "Clear"], [1, "Mainly Clear"], [2, "Partly Cloudy"], [3, "Overcast"],
  [45, "Fog"], [48, "Freezing Fog"],
  [51, "Light Drizzle"], [53, "Drizzle"], [55, "Heavy Drizzle"],
  [56, "Freezing Drizzle"], [57, "Freezing Drizzle"],
  [61, "Light Rain"], [63, "Rain"], [65, "Heavy Rain"],
  [66, "Freezing Rain"], [67, "Freezing Rain"],
  [71, "Light Snow"], [73, "Snow"], [75, "Heavy Snow"], [77, "Snow Grains"],
  [80, "Rain Showers"], [81, "Rain Showers"], [82, "Heavy Rain Showers"],
  [85, "Snow Showers"], [86, "Heavy Snow Showers"],
  [95, "Thunderstorms"], [96, "Thunderstorms with Hail"], [99, "Thunderstorms with Hail"]
]);

// ------------------------------------------------------------------ helpers

/**
 * A number, or null for anything that is not one.
 *
 * The typeof guard is the point: NWS sends `probabilityOfPrecipitation: {value:
 * null}` on a dry hour, and Number(null) is 0 — which would have shown "Rain 0%"
 * for "no data", and 0° for a missing temperature.
 */
function num(v){
  if(typeof v !== "number" && typeof v !== "string") return null;
  if(typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** NWS reports Fahrenheit for US offices, but the unit is not guaranteed. */
export function toFahrenheit(value, unit){
  const n = num(value);
  if(n === null) return null;
  return String(unit || "F").toUpperCase().startsWith("C") ? Math.round(n * 9 / 5 + 32) : n;
}

function ms(iso){
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "10 mph" and "5 to 15 mph" both answer 15 — the number worth warning about. */
export function maxWindMph(text){
  const found = String(text || "").match(/\d+/g);
  if(!found) return null;
  return Math.max(...found.map(Number));
}

function mentionsThunder(...texts){
  return texts.some(t => /thunder|t-?storm/i.test(String(t || "")));
}

/** The local YYYY-MM-DD of a timestamp, for matching a daily array by date. */
export function localDateString(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --------------------------------------------------------------- NWS pieces

/**
 * Hourly periods that fall inside the logbook day, reduced to the numbers the
 * banner needs. The hourly forecast starts at the current hour, so on an
 * afternoon fetch this describes the rest of the day rather than all of it —
 * hence the daily periods below are preferred for high/low.
 */
export function hourlyStats(periods, dayStart, dayEnd){
  const out = { max: null, min: null, peakAt: null, pop: null, thunder: false, windMph: null };
  if(!Array.isArray(periods)) return out;

  for(const p of periods){
    const start = ms(p?.startTime);
    if(start === null || start < dayStart || start >= dayEnd) continue;

    const temp = toFahrenheit(p.temperature, p.temperatureUnit);
    if(temp !== null){
      if(out.max === null || temp > out.max){ out.max = temp; out.peakAt = start; }
      if(out.min === null || temp < out.min) out.min = temp;
    }

    const pop = num(p.probabilityOfPrecipitation?.value);
    if(pop !== null && (out.pop === null || pop > out.pop)) out.pop = pop;

    const wind = maxWindMph(p.windSpeed);
    if(wind !== null && (out.windMph === null || wind > out.windMph)) out.windMph = wind;

    if(mentionsThunder(p.shortForecast, p.detailedForecast)) out.thunder = true;
  }
  return out;
}

/**
 * The twice-daily forecast periods — "Today", "Tonight" — that overlap the
 * logbook day. These carry the official high and low, including one that has
 * already happened, which the hourly feed can no longer show.
 */
export function dailyStats(periods, dayStart, dayEnd, now){
  const out = { high: null, low: null, condition: "", pop: null, thunder: false, windMph: null };
  if(!Array.isArray(periods)) return out;

  let current = null;
  let firstDay = null;
  for(const p of periods){
    const start = ms(p?.startTime);
    const end = ms(p?.endTime);
    if(start === null) continue;
    // Overlap, not containment: a period that straddles 4:00am belongs to both
    // logbook days and should count for each.
    if(start >= dayEnd) continue;
    if(end !== null && end <= dayStart) continue;

    const temp = toFahrenheit(p.temperature, p.temperatureUnit);
    if(temp !== null){
      if(p.isDaytime){
        if(out.high === null || temp > out.high) out.high = temp;
      } else if(out.low === null || temp < out.low){
        out.low = temp;
      }
    }

    const pop = num(p.probabilityOfPrecipitation?.value);
    if(pop !== null && (out.pop === null || pop > out.pop)) out.pop = pop;

    const wind = maxWindMph(p.windSpeed);
    if(wind !== null && (out.windMph === null || wind > out.windMph)) out.windMph = wind;

    if(mentionsThunder(p.shortForecast, p.detailedForecast)) out.thunder = true;

    if(current === null && end !== null && start <= now && now < end) current = p;
    if(firstDay === null && p.isDaytime) firstDay = p;
  }

  out.condition = String((current || firstDay || {}).shortForecast || "");
  return out;
}

/**
 * Watches, warnings and advisories the NWS has out for this point, filtered to
 * the ones actually in force during the logbook day and ordered worst-first.
 */
export function alertWarnings(alerts, dayStart, dayEnd, now){
  const features = Array.isArray(alerts?.features) ? alerts.features : [];
  const live = [];
  for(const f of features){
    const p = f?.properties;
    if(!p?.event) continue;
    const ends = ms(p.ends) ?? ms(p.expires) ?? Infinity;
    const onset = ms(p.onset) ?? ms(p.effective) ?? 0;
    if(ends <= Math.max(now, dayStart)) continue;
    if(onset >= dayEnd) continue;
    live.push({
      id: `alert:${p.event}`,
      label: String(p.event).slice(0, 60),
      detail: String(p.headline || p.event).slice(0, 160),
      rank: SEVERITY_RANK[p.severity] ?? SEVERITY_RANK.Unknown
    });
  }
  live.sort((a, b) => a.rank - b.rank);

  const seen = new Set();
  return live.filter(w => !seen.has(w.id) && seen.add(w.id)).slice(0, 3)
    .map(({ id, label, detail }) => ({ id, label, detail }));
}

/**
 * The things worth flagging that no agency issues a bulletin for: a high UV
 * index, storms in the forecast text, heat, a freeze, a windy day.
 *
 * Kept separate from alertWarnings() so an official Heat Advisory always wins
 * the top slot over a derived one.
 */
export function derivedWarnings({ high, low, uvIndex, thunder, windMph, rainChance }){
  const out = [];
  if(uvIndex !== null && uvIndex !== undefined){
    const uv = Math.round(uvIndex);
    if(uv >= 8) out.push({ id: "uv", label: `UV very high (${uv})`, detail: "Burn time under 15 minutes. Cover up." });
    else if(uv >= 6) out.push({ id: "uv", label: `UV high (${uv})`, detail: "Sunscreen if you're out for long." });
  }
  if(thunder) out.push({ id: "storms", label: "Chance of storms", detail: "Thunderstorms in the forecast." });
  if(high !== null && high >= 95) out.push({ id: "heat", label: `Heat — ${high}°`, detail: "Hydrate; move outdoor work early." });
  if(low !== null && low <= 32) out.push({ id: "freeze", label: `Freezing — ${low}°`, detail: "Below freezing overnight." });
  if(windMph !== null && windMph >= 25) out.push({ id: "wind", label: `Windy — ${windMph} mph`, detail: "Secure anything loose outside." });
  if(rainChance !== null && rainChance >= 70 && !thunder){
    out.push({ id: "rain", label: `Rain likely (${rainChance}%)`, detail: "Plan outdoor time around it." });
  }
  return out;
}

// -------------------------------------------------------------- summarisers

/**
 * @param {object} raw   { points, forecast, hourly, alerts, uvIndex }
 * @param {object} opts  { now, dayStart, dayEnd }
 */
export function summarizeNws(raw, opts){
  const { now, dayStart, dayEnd } = opts;
  const hourly = hourlyStats(raw.hourly?.properties?.periods, dayStart, dayEnd);
  const daily = dailyStats(raw.forecast?.properties?.periods, dayStart, dayEnd, now);

  const high = daily.high ?? hourly.max;
  const low = daily.low ?? hourly.min;
  const rainChance = Math.max(daily.pop ?? -1, hourly.pop ?? -1);
  const windMph = Math.max(daily.windMph ?? -1, hourly.windMph ?? -1);
  const uvIndex = num(raw.uvIndex);

  const rel = raw.points?.properties?.relativeLocation?.properties;
  const place = rel?.city ? `${rel.city}${rel.state ? `, ${rel.state}` : ""}` : "";

  return {
    source: "nws",
    place,
    high,
    low,
    condition: daily.condition,
    rainChance: rainChance < 0 ? null : rainChance,
    peakTemp: hourly.max,
    peakAt: hourly.peakAt,
    uvIndex,
    warnings: [
      ...alertWarnings(raw.alerts, dayStart, dayEnd, now),
      ...derivedWarnings({
        high, low, uvIndex,
        thunder: daily.thunder || hourly.thunder,
        windMph: windMph < 0 ? null : windMph,
        rainChance: rainChance < 0 ? null : rainChance
      })
    ]
  };
}

/**
 * The fallback, used when NWS cannot answer for these coordinates — outside its
 * coverage, or down. Open-Meteo is also where the UV index comes from even on
 * the NWS path: the NWS public API does not publish one.
 */
export function summarizeOpenMeteo(payload, opts){
  const { dayStart, dayEnd } = opts;
  const daily = payload?.daily || {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const idx = Math.max(0, times.indexOf(localDateString(dayStart)));
  const pick = (key) => Array.isArray(daily[key]) ? num(daily[key][idx]) : null;

  const high = pick("temperature_2m_max");
  const low = pick("temperature_2m_min");
  const rainChance = pick("precipitation_probability_max");
  const uvIndex = pick("uv_index_max");
  const code = pick("weather_code");
  const windMph = pick("wind_speed_10m_max");

  // Hourly arrays are parallel: times[i] describes temperature[i].
  const hTimes = Array.isArray(payload?.hourly?.time) ? payload.hourly.time : [];
  const hTemps = Array.isArray(payload?.hourly?.temperature_2m) ? payload.hourly.temperature_2m : [];
  let peakTemp = null;
  let peakAt = null;
  for(let i = 0; i < hTimes.length; i++){
    const t = ms(hTimes[i]);
    const temp = num(hTemps[i]);
    if(t === null || temp === null || t < dayStart || t >= dayEnd) continue;
    if(peakTemp === null || temp > peakTemp){ peakTemp = temp; peakAt = t; }
  }

  const condition = WMO.get(code) || "";
  const thunder = code !== null && code >= 95;

  return {
    source: "open-meteo",
    place: "",
    high: high === null ? null : Math.round(high),
    low: low === null ? null : Math.round(low),
    condition,
    rainChance,
    peakTemp: peakTemp === null ? null : Math.round(peakTemp),
    peakAt,
    uvIndex,
    warnings: derivedWarnings({
      high: high === null ? null : Math.round(high),
      low: low === null ? null : Math.round(low),
      uvIndex, thunder,
      windMph: windMph === null ? null : Math.round(windMph),
      rainChance
    })
  };
}

/**
 * The one number pulled out of Open-Meteo even when NWS answered: its daily
 * arrays are parallel to `daily.time`, so the day is matched by date string.
 */
export function dailyUvIndex(payload, dayStart){
  const daily = payload?.daily || {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const values = Array.isArray(daily.uv_index_max) ? daily.uv_index_max : [];
  const idx = Math.max(0, times.indexOf(localDateString(dayStart)));
  return num(values[idx]);
}

/** Whether a summary carries enough to be worth showing at all. */
export function isUsableSummary(s){
  return !!s && (s.high !== null || s.low !== null || !!s.condition || !!s.warnings?.length);
}

export { WMO as WMO_CODES };
