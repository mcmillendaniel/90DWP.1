/**
 * The weather summary: turning provider payloads into the Home banner's line.
 *
 * Run with:  TZ=America/New_York node --test "tests/*.test.mjs"
 *
 * Nothing here touches the network. The payloads below are trimmed copies of
 * what api.weather.gov and api.open-meteo.com actually return, which is the
 * only part of those services this app depends on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizeNws, summarizeOpenMeteo, hourlyStats, dailyStats, alertWarnings,
  derivedWarnings, dailyUvIndex, maxWindMph, toFahrenheit, isUsableSummary
} from "../js/weather/summary.js";
import { normalizeWeatherSettings, parseCoords } from "../js/weather/settings.js";

/** The logbook day for these fixtures: 2026-08-10 04:00 → 2026-08-11 04:00. */
const DAY_START = new Date(2026, 7, 10, 4, 0, 0, 0).getTime();
const DAY_END = new Date(2026, 7, 11, 4, 0, 0, 0).getTime();
const NOW = new Date(2026, 7, 10, 7, 30, 0, 0).getTime();

const iso = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).toISOString();

function hour(h, temp, pop, short = "Sunny", day = 10){
  return {
    startTime: iso(2026, 8, day, h),
    endTime: iso(2026, 8, day, h + 1),
    isDaytime: h >= 7 && h < 20,
    temperature: temp,
    temperatureUnit: "F",
    probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: pop },
    windSpeed: "8 mph",
    shortForecast: short
  };
}

const HOURLY = {
  properties: {
    periods: [
      hour(5, 72, 5),
      hour(8, 78, 10),
      hour(12, 88, 20),
      hour(16, 93, 45, "Chance Showers And Thunderstorms"),
      hour(19, 86, 30),
      hour(23, 76, 10),
      // Tomorrow, past the 4:00am rollover — must not count toward today.
      hour(6, 104, 90, "Sunny", 11)
    ]
  }
};

const FORECAST = {
  properties: {
    periods: [
      {
        number: 1, name: "Today", isDaytime: true,
        startTime: iso(2026, 8, 10, 6), endTime: iso(2026, 8, 10, 18),
        temperature: 94, temperatureUnit: "F",
        probabilityOfPrecipitation: { value: 50 },
        windSpeed: "5 to 10 mph",
        shortForecast: "Partly Sunny then Chance Showers And Thunderstorms",
        detailedForecast: "A chance of showers and thunderstorms after 2pm."
      },
      {
        number: 2, name: "Tonight", isDaytime: false,
        startTime: iso(2026, 8, 10, 18), endTime: iso(2026, 8, 11, 6),
        temperature: 71, temperatureUnit: "F",
        probabilityOfPrecipitation: { value: 20 },
        windSpeed: "5 mph",
        shortForecast: "Mostly Clear", detailedForecast: "Mostly clear."
      },
      {
        number: 3, name: "Tuesday", isDaytime: true,
        startTime: iso(2026, 8, 11, 6), endTime: iso(2026, 8, 11, 18),
        temperature: 99, temperatureUnit: "F",
        probabilityOfPrecipitation: { value: 80 },
        windSpeed: "10 mph",
        shortForecast: "Hot", detailedForecast: "Hot."
      }
    ]
  }
};

const POINTS = {
  properties: {
    forecast: "https://api.weather.gov/gridpoints/GSP/116,58/forecast",
    forecastHourly: "https://api.weather.gov/gridpoints/GSP/116,58/forecast/hourly",
    relativeLocation: { properties: { city: "Charlotte", state: "NC" } }
  }
};

const ALERTS = {
  features: [
    {
      properties: {
        event: "Heat Advisory", severity: "Moderate",
        headline: "Heat Advisory in effect until 8 PM",
        onset: iso(2026, 8, 10, 11), ends: iso(2026, 8, 10, 20)
      }
    },
    {
      properties: {
        event: "Severe Thunderstorm Watch", severity: "Severe",
        headline: "Severe Thunderstorm Watch until 10 PM",
        onset: iso(2026, 8, 10, 14), ends: iso(2026, 8, 10, 22)
      }
    },
    {
      // Already over before the day began.
      properties: {
        event: "Flood Warning", severity: "Severe",
        headline: "Flood Warning", onset: iso(2026, 8, 9, 2), ends: iso(2026, 8, 9, 20)
      }
    },
    {
      // Not until the day after; nothing to say about today.
      properties: {
        event: "Winter Storm Watch", severity: "Extreme",
        headline: "Winter Storm Watch", onset: iso(2026, 8, 12, 2), ends: iso(2026, 8, 13, 20)
      }
    }
  ]
};

const OPEN_METEO = {
  daily: {
    time: ["2026-08-10", "2026-08-11"],
    temperature_2m_max: [93.6, 99.1],
    temperature_2m_min: [70.8, 74.2],
    precipitation_probability_max: [55, 80],
    uv_index_max: [9.2, 8.1],
    weather_code: [95, 0],
    wind_speed_10m_max: [12.4, 9.9]
  },
  hourly: {
    time: [
      iso(2026, 8, 10, 5), iso(2026, 8, 10, 12), iso(2026, 8, 10, 16),
      iso(2026, 8, 10, 23), iso(2026, 8, 11, 6)
    ],
    temperature_2m: [72, 88, 93.6, 76, 104]
  }
};

// -------------------------------------------------------------- primitives

test("toFahrenheit passes F through and converts C", () => {
  assert.equal(toFahrenheit(88, "F"), 88);
  assert.equal(toFahrenheit(30, "C"), 86);
  assert.equal(toFahrenheit(null, "F"), null);
  assert.equal(toFahrenheit("nope", "F"), null);
});

test("maxWindMph reads the top of a range", () => {
  assert.equal(maxWindMph("5 to 15 mph"), 15);
  assert.equal(maxWindMph("10 mph"), 10);
  assert.equal(maxWindMph(""), null);
});

// ------------------------------------------------------------- NWS pieces

test("hourlyStats stays inside the logbook day", () => {
  const s = hourlyStats(HOURLY.properties.periods, DAY_START, DAY_END);
  // The 104° hour is 6am tomorrow — past the 4:00am rollover.
  assert.equal(s.max, 93);
  assert.equal(s.min, 72);
  assert.equal(new Date(s.peakAt).getHours(), 16, "peak is the 4pm hour");
  assert.equal(s.pop, 45);
  assert.equal(s.thunder, true);
});

test("dailyStats takes the high from the day and the low from the night", () => {
  const s = dailyStats(FORECAST.properties.periods, DAY_START, DAY_END, NOW);
  assert.equal(s.high, 94, "Today's high, not tomorrow's 99");
  assert.equal(s.low, 71, "tonight's low, even though it lands after 4am");
  assert.equal(s.pop, 50);
  assert.equal(s.windMph, 10);
  assert.equal(s.thunder, true);
  assert.match(s.condition, /Partly Sunny/, "the period covering now supplies the condition");
});

test("dailyStats picks the period that contains now", () => {
  const evening = new Date(2026, 7, 10, 21, 0, 0, 0).getTime();
  const s = dailyStats(FORECAST.properties.periods, DAY_START, DAY_END, evening);
  assert.equal(s.condition, "Mostly Clear");
});

test("alertWarnings keeps only what is in force today, worst first", () => {
  const w = alertWarnings(ALERTS, DAY_START, DAY_END, NOW);
  assert.deepEqual(w.map(x => x.label), ["Severe Thunderstorm Watch", "Heat Advisory"]);
  assert.match(w[0].detail, /until 10 PM/);
});

test("alertWarnings survives a missing or malformed payload", () => {
  assert.deepEqual(alertWarnings(null, DAY_START, DAY_END, NOW), []);
  assert.deepEqual(alertWarnings({ features: [{}, { properties: {} }] }, DAY_START, DAY_END, NOW), []);
  // No end time at all means "until further notice", not "already over".
  const openEnded = { features: [{ properties: { event: "Air Quality Alert" } }] };
  assert.equal(alertWarnings(openEnded, DAY_START, DAY_END, NOW).length, 1);
});

test("derivedWarnings flags UV, storms, heat, freeze and wind", () => {
  const labels = (opts) => derivedWarnings({
    high: null, low: null, uvIndex: null, thunder: false, windMph: null, rainChance: null, ...opts
  }).map(w => w.id);

  assert.deepEqual(labels({ uvIndex: 9.2 }), ["uv"]);
  assert.deepEqual(labels({ uvIndex: 6 }), ["uv"]);
  assert.deepEqual(labels({ uvIndex: 4 }), [], "a moderate UV index is not worth a chip");
  assert.deepEqual(labels({ thunder: true }), ["storms"]);
  assert.deepEqual(labels({ high: 97 }), ["heat"]);
  assert.deepEqual(labels({ low: 28 }), ["freeze"]);
  assert.deepEqual(labels({ windMph: 30 }), ["wind"]);
  assert.deepEqual(labels({ rainChance: 80 }), ["rain"]);
  assert.deepEqual(labels({ rainChance: 80, thunder: true }), ["storms"], "storms already say it");
});

// ------------------------------------------------------------ summarisers

test("summarizeNws builds the banner line", () => {
  const s = summarizeNws(
    { points: POINTS, forecast: FORECAST, hourly: HOURLY, alerts: ALERTS, uvIndex: 9.2 },
    { now: NOW, dayStart: DAY_START, dayEnd: DAY_END }
  );

  assert.equal(s.source, "nws");
  assert.equal(s.place, "Charlotte, NC");
  assert.equal(s.high, 94);
  assert.equal(s.low, 71);
  assert.equal(s.rainChance, 50, "the highest chance the day carries");
  assert.equal(s.peakTemp, 93);
  assert.equal(new Date(s.peakAt).getHours(), 16);
  assert.equal(s.uvIndex, 9.2);
  assert.ok(isUsableSummary(s));

  // Official alerts come before anything derived.
  assert.deepEqual(s.warnings.map(w => w.label).slice(0, 2),
    ["Severe Thunderstorm Watch", "Heat Advisory"]);
  assert.ok(s.warnings.some(w => w.id === "uv"), "the UV index is still flagged");
});

test("summarizeNws copes with a payload missing everything optional", () => {
  const s = summarizeNws({ points: null, forecast: null, hourly: null, alerts: null, uvIndex: null },
    { now: NOW, dayStart: DAY_START, dayEnd: DAY_END });
  assert.equal(s.high, null);
  assert.equal(s.low, null);
  assert.equal(s.rainChance, null);
  assert.equal(s.peakAt, null);
  assert.equal(s.place, "");
  assert.deepEqual(s.warnings, []);
  assert.equal(isUsableSummary(s), false, "nothing to show is reported as nothing to show");
});

test("summarizeNws falls back to hourly when the daily periods are gone", () => {
  const s = summarizeNws({ points: POINTS, forecast: null, hourly: HOURLY, alerts: null, uvIndex: null },
    { now: NOW, dayStart: DAY_START, dayEnd: DAY_END });
  assert.equal(s.high, 93);
  assert.equal(s.low, 72);
});

test("summarizeOpenMeteo reads the right day and rounds", () => {
  const s = summarizeOpenMeteo(OPEN_METEO, { now: NOW, dayStart: DAY_START, dayEnd: DAY_END });
  assert.equal(s.source, "open-meteo");
  assert.equal(s.high, 94);
  assert.equal(s.low, 71);
  assert.equal(s.rainChance, 55);
  assert.equal(s.uvIndex, 9.2);
  assert.equal(s.condition, "Thunderstorms");
  assert.equal(s.peakTemp, 94);
  assert.equal(new Date(s.peakAt).getHours(), 16, "tomorrow's hotter hour does not win");
  assert.deepEqual(s.warnings.map(w => w.id), ["uv", "storms"]);
});

test("dailyUvIndex matches the logbook day by date, not by position", () => {
  assert.equal(dailyUvIndex(OPEN_METEO, DAY_START), 9.2);
  assert.equal(dailyUvIndex(OPEN_METEO, DAY_END), 8.1);
  assert.equal(dailyUvIndex(null, DAY_START), null);
  assert.equal(dailyUvIndex({ daily: {} }, DAY_START), null);
});

// ------------------------------------------------------------- settings

test("normalizeWeatherSettings clamps and pairs coordinates", () => {
  assert.deepEqual(normalizeWeatherSettings(null), { lat: null, lon: null, label: "" });
  assert.deepEqual(normalizeWeatherSettings({ lat: 35.22714, lon: -80.84313, label: "Charlotte, NC" }),
    { lat: 35.2271, lon: -80.8431, label: "Charlotte, NC" });
  assert.deepEqual(normalizeWeatherSettings({ lat: 99, lon: 10 }),
    { lat: null, lon: null, label: "" }, "an impossible latitude takes the pair with it");
  assert.deepEqual(normalizeWeatherSettings({ lat: 35.2 }),
    { lat: null, lon: null, label: "" }, "half a location is no location");
});

test("parseCoords accepts what someone would actually type", () => {
  assert.deepEqual(parseCoords("35.2271, -80.8431"), { lat: 35.2271, lon: -80.8431 });
  assert.deepEqual(parseCoords("  35.2271 -80.8431 "), { lat: 35.2271, lon: -80.8431 });
  assert.equal(parseCoords("Charlotte"), null);
  assert.equal(parseCoords("35.2271"), null);
  assert.equal(parseCoords(""), null);
});

test("an unset location does not become Null Island", () => {
  // Number(null) is 0, and 0,0 is a real point in the Gulf of Guinea.
  assert.deepEqual(normalizeWeatherSettings({}), { lat: null, lon: null, label: "" });
  assert.deepEqual(normalizeWeatherSettings({ lat: null, lon: null }), { lat: null, lon: null, label: "" });
  assert.deepEqual(normalizeWeatherSettings({ lat: "", lon: "" }), { lat: null, lon: null, label: "" });
  // A genuine zero is still a coordinate.
  assert.deepEqual(normalizeWeatherSettings({ lat: 0, lon: 0 }), { lat: 0, lon: 0, label: "" });
});
