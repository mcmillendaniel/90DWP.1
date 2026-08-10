# 90DWP.1

A personal daily-execution tracker. Single-user, installed to an iPhone home
screen as a PWA. Logs a small set of daily events and outcomes, keeps a short
history, and can send itself push notifications.

Not a product. No accounts, no user table, no analytics, no third-party services
beyond static hosting and one Cloudflare Worker.

---

## What it does

Six tabs, driven by a bottom tab bar.

| Tab | Purpose |
| --- | --- |
| **Home** | A banner with today's date and the day's weather, four one-tap event buttons — *I'm up*, *Baby up*, *Nap start*, *Nap end* — and the reminders due today. Each event button records a timestamp; tapping a logged event again opens a time picker to correct it. |
| **Checkoffs** | Write three outcomes for the day and check them off. Completing all three fires a "day secured" notification. Can pull a suggestion from the most recent unfinished outcome. |
| **Morning** | Four morning-routine items — movement, shower, outcomes written, meds. Same log-then-edit behaviour as events. |
| **Reminders** | A full reminders app — lists, due dates, repeats, priorities, flags, tags, subtasks, and lock-screen alerts. See [The Reminders tab](#the-reminders-tab). |
| **History** | Last seven days: outcomes completed, wake time, baby-up time. |
| **Settings** | Push enable/disable, JSON+CSV export, JSON import, device ID, and a notification diagnostics panel. |

A ticker in the header cycles the three outcomes every 3.5s with a red / yellow /
green dot for none / some / all complete.

Tapping **I'm up** opens a full-screen wake modal whose tone adapts to the
current streak and wake-time consistency — direct when the streak is short,
steadier once it's established — then drops the user on the Morning tab.

### The logbook day

Days are keyed `YYYY-MM-DD` and **start at 4:00am local time**, not midnight.
Anything logged between midnight and 4am belongs to the previous day. This
matters for a tracker used by someone awake at odd hours, and it is the single
most subtle piece of logic in the app.

---

## Stack

**Client** — vanilla ES modules. No framework, no build step, no dependencies,
no bundler. Files are served exactly as committed.

- ES2022 JavaScript, native `<script type="module">`
- Hand-written CSS with custom properties
- Service worker for offline shell and push receipt
- `localStorage` for all persistence
- Hosted on **GitHub Pages**, deployed from `main`

**Backend** — one Cloudflare Worker, `90dwp-push`.

- Cloudflare Workers runtime (not Node)
- **Workers KV** for subscriptions and the pending-notification queue
  (binding `PUSH_KV` → namespace `PUSH_KV_PROD`)
- **Cron Trigger** `* * * * *` sweeps for due notifications
- `@pushforge/builder` for VAPID signing and payload encryption — chosen because
  the usual `web-push` npm package depends on Node crypto and does not run in
  the Workers runtime
- Deployed via `wrangler` or the dashboard code editor

**Delivery** — standard Web Push. On iPhone that terminates at
`web.push.apple.com` and requires **no Apple Developer account, no App Store
presence, and no APNs certificate.** iOS 16.4+ supports web push for home-screen
web apps.

---

## Repository layout

```
index.html                app shell: header ticker, <main>, tab bar, modals
app.js                    entry point (~70 lines) — boot sequence only
styles.css                all styling
manifest.webmanifest      PWA manifest
sw.js                     service worker: caching + push + notification click

js/
  config.js               constants (worker URL, reset hour, storage keys)
  dom.js                  $, toast, escapeHtml
  uid.js                  id generation
  state.js                persistence, day keying, time formatting
  push.js                 subscription, scheduling, cancelling, diagnostics
  wake.js                 wake modal + adaptive messaging
  timepicker.js           drum-style time editor
  views.js                HTML for each tab
  backup.js               export / import
  ui.js                   render loop, event wiring, action dispatch

js/weather/
  settings.js             the stored location + its normaliser
  summary.js              provider payloads -> the banner's summary (pure)
  sources.js              the NWS and Open-Meteo fetches
  service.js              cache, refresh policy, location
  view.js                 the Home banner and the Settings card

js/reminders/
  recur.js                date arithmetic, repeat rules, occurrence series
  parse.js                natural-language quick-add parsing
  schema.js               record shapes + the normaliser
  model.js                lists, items, CRUD, smart lists, search
  schedule.js             expands reminders into queued push notifications
  nav.js                  which reminders screen is open
  views.js                HTML for the reminders screens
  actions.js              reminders action dispatch

tests/                    node --test suite, no dependencies

worker/
  src/index.ts            the Cloudflare Worker
  wrangler.toml           config (KV namespace id must be filled in)
  generate-vapid.mjs      mints a fresh VAPID keypair
  vapid-to-jwk.mjs        converts an existing raw keypair to JWK
  README.md               worker setup + secrets
  DASHBOARD-PATCH.md      deploying without wrangler
```

There are **no dependency cycles**. `ui.js` is the only module aware of both
views and actions, and `reminders/actions.js` is the only one aware of both the
reminders model and its navigation.

`state.js` normalizes through `reminders/schema.js`, which is why the schema is
a separate file from `reminders/model.js` — the model imports `state.js`, so
folding the two together would close a cycle. `uid.js` exists for the same
reason.

## Tests

```
TZ=America/New_York node --test "tests/*.test.mjs"
```

75 tests over the date arithmetic, the repeat rules, the quick-add parser, the
reminders store, the Home agenda, and the weather summary — the last of these
against trimmed copies of real NWS and Open-Meteo payloads, so no test touches
the network. No dependencies and no runner — `tests/` uses the Node
built-in. Pin `TZ` when running them: the date logic is timezone-sensitive by
nature, and a suite that only passes at UTC+0 is the exact bug this app has
already shipped once.

The DOM layer is not covered. It was verified by driving the real app under
jsdom, but that needs a dependency the repo does not carry.

---

## Data model

Everything lives under one `localStorage` key, `90dwp_state_v1`:

```js
{
  deviceId: "uuid",                    // identifies this device to the worker
  settings: {
    pushEnabled: bool,
    weather: { lat, lon, label }       // null coordinates = no location set
  },
  days: {
    "2026-07-25": {
      createdAt: 1690000000000,
      outcomes:     ["", "", ""],
      outcomesDone: [false, false, false],
      events:  { imUp: ts, babyUp: ts, napStart: ts, napEnd: ts },
      morning: { movement: ts, shower: ts, outcomesWritten: ts, meds: ts }
    }
  },
  reminders: {
    lists: [
      { id, name, icon, color, sort, order, createdAt }
    ],
    items: [
      {
        id, listId, title, notes, url,
        dueAt,          // epoch ms, or null for a reminder with no date
        hasTime,        // false = all-day, alerts at settings.allDayAlertHour
        repeat,         // null, or { freq, interval, weekdays?, until? }
        earlyMin,       // alert this many minutes before dueAt
        priority,       // 0 none, 1 low, 2 medium, 3 high
        flagged, tags: [], subtasks: [{ id, title, done }],
        completed, completedAt,
        lastDoneAt,     // last checked off, including repeats that then advanced
        createdAt, updatedAt, order,
        pushSig         // fingerprint of what was last queued — see below
      }
    ],
    settings: { allDayAlertHour: 9, defaultListId, showCompleted }
  }
}
```

A reminder's `dueAt` is the moment it is **due**; `earlyMin` shifts only when it
**alerts**. Repeats advance the due date, and the alert is re-derived from it.

All timestamps are epoch milliseconds. `null` means not logged.

`normalizeState()` runs on both load and import, so a partial or hand-edited
blob cannot crash startup. `state` is exported as a live binding and is only
ever reassigned through `replaceState()`, which preserves the device id.

Two further keys sit outside that blob because neither belongs in a logbook
export: `90dwp_last_push_result` holds the most recent notification test result
so it survives a reload, and `90dwp_weather_v1` holds the last fetched forecast
so the banner has something to paint before the network answers.

> Days written before July 2026 may carry a leftover `scheduled` key from the
> removed time-block feature. It is inert; nothing reads it.

---

## The Home banner

### Weather

The banner across the top of Home is the day's date on the left and a summary of
the day's weather on the right: high and low, chance of rain, when the
temperature peaks, and anything worth a warning.

**Where the data comes from.** The primary source is the **National Weather
Service** (`api.weather.gov`) — the agency whose forecasts every US weather
service, the Weather Channel included, is ultimately derived from. It is free,
needs no key, sends `Access-Control-Allow-Origin: *` so a static page can call it
directly, and it is the only source carrying official watches, warnings and
advisories.

**Open-Meteo** is called alongside it for the one thing NWS does not publish in
its public API — the **UV index** — and stands in as the whole forecast when NWS
cannot answer, which is anywhere outside US coverage.

Three requests make up an NWS refresh: `/points/{lat},{lon}` to resolve the
forecast grid (cached — it never changes for a point), then the daily and hourly
forecasts for that grid, plus `/alerts/active`. A failed alerts call is allowed
to pass: a missing advisory should not cost the banner its temperatures.

**Warnings** are official NWS alerts in force during the logbook day, worst
severity first, followed by derived ones: UV index ≥ 6, thunderstorms in the
forecast text, a high ≥ 95°, a low ≤ 32°, wind ≥ 25 mph, rain ≥ 70%.

**High and low** come from the NWS daily periods rather than the hourly feed,
because the hourly forecast begins at the current hour — by the afternoon it can
no longer see the day's high. The **peak time** does come from the hourly feed,
which is the only place it exists.

**Caching.** The last summary is written to `90dwp_weather_v1` and rendered
immediately on launch, so a phone with no signal opens to this morning's forecast
with an "as of" time on it rather than an empty box. A refresh runs in the
background when the cached copy is over 30 minutes old, when the logbook day has
turned over, or when the app is brought back to the foreground — and re-renders
only if something changed. Nothing on this path is awaited by the first render.

**Location** is set in Settings, either from the device (one fix, not watched —
a forecast grid is miles across) or by typing coordinates, which is the way to
pin the forecast to home rather than to wherever the phone is. With no location
set the banner says so and offers the button; it never guesses.

### Today's reminders

Below the event buttons, Home lists the reminders due **today**, where today is
the logbook day — 4:00am to 4:00am, like everything else in the app.

- A dated reminder appears on the day it is due **and not before**. A doctor's
  appointment set today for next Tuesday shows up on next Tuesday morning,
  already there before its alert fires.
- Once it appears it **stays for the rest of the day**, checked off or not, so
  the list reads as a record of the day instead of emptying itself as it is
  worked through. It clears when the day does.
- Overdue reminders carry forward, marked as such — the same rule the Today
  smart list follows.
- Undated reminders never appear: with no date they have no day to land on.

Two things can be done from here and no more: **check one off**, or **tap it to
open its editor** in the Reminders tab. There is deliberately no composer —
reminders are authored in the Reminders tab and appear here on their day.

A repeating reminder checked off from Home advances to its next occurrence, as
it does everywhere else, but it keeps showing as done for the rest of today
rather than vanishing into tomorrow. That is what `lastDoneAt` is for:
`completedAt` cannot answer "was this done today" for a repeat, because it is
null again the moment the item rolls forward. Checking the same daily reminder
off twice in one day is now a no-op instead of skipping a day.

---

## The notification pipeline

```
app  ──POST /schedule──▶  Worker  ──▶  KV   "sched:<device>:<tag>:<id>"
                                        │
                       cron (every minute) sweeps for sendAt <= now
                                        │
                       sign VAPID JWT + encrypt payload
                                        ▼
                            web.push.apple.com
                                        ▼
                       sw.js 'push' → showNotification()
```

**Worker routes**

| Route | Purpose |
| --- | --- |
| `GET /vapidPublicKey` | Public key the client subscribes against |
| `POST /subscribe` | Stores `sub:<deviceId>` |
| `POST /schedule` | Queues a notification |
| `POST /cancelPrefix` | Deletes queued notifications by tag prefix |
| `GET /debug` | Counts and which secrets are set. Returns no key material. |
| `POST /sendNow` | Immediate send, bypasses the cron, returns the push service's real status |

**Client API** — the entire surface is one function:

```js
schedulePush(tag, title, body, sendAtMs, extra?)  // → Promise<boolean>
```

It returns `false` and toasts a specific error rather than throwing. It never
fails silently.

### Timing

`sendAt` is a **floor, not a target.** Realistic delivery is **1–3 minutes**
after the scheduled time, because:

- the cron runs once a minute
- Cloudflare does not fire cron triggers to the second
- a KV write can take up to a minute to become visible at the edge running the sweep
- iOS may hold delivery under Low Power Mode or a Focus filter

Fine for habit nudges. Not suitable for anything time-critical.

### iOS constraints

- Push works **only** when launched from the home-screen icon. In a Safari tab
  `window.Notification` does not exist and enabling will fail.
- **Notification action buttons are not supported.** Any interaction must happen
  after the tap, inside the app.
- `Notification.requestPermission()` must be called **synchronously inside the
  click handler.** Awaiting anything first — a service worker registration, a
  fetch — consumes the user gesture and WebKit rejects the call.

---

## The Reminders tab

A reminders app modelled on iOS Reminders, living inside this one and delivering
its alerts through the same web-push pipeline — so they arrive on the Home
Screen and the Lock Screen with the app closed.

### What it does

| | |
| --- | --- |
| **Lists** | Any number, each with a name, an emoji icon and a colour. Reorderable. Deleting a list deletes its reminders and cancels their queued notifications. |
| **Smart lists** | Today, Scheduled, All, Flagged, Completed, with live counts. Today includes overdue, so a missed reminder does not disappear. |
| **Quick add** | One field, parsed as you'd say it: `call the pediatrician tomorrow at 9am every 3 months !! #health` sets the date, time, repeat, priority and tag, and leaves `call the pediatrician` as the title. |
| **Due dates** | A date alone is all-day and alerts at `allDayAlertHour` (09:00 by default); adding a time alerts at that time. |
| **Repeats** | Hourly, daily, weekdays, weekend days, weekly, every 2 weeks, monthly, every 3 or 6 months, yearly, or custom (any interval, and specific weekdays for weekly rules), with an optional end date. |
| **Early alerts** | 5 minutes to 1 week before the due time. |
| **Priority** | None / low / medium / high, shown as `!` `!!` `!!!`, and sortable. |
| **Flags, tags, notes, URL** | As in iOS. Tags are also a filter row on the reminders home. |
| **Subtasks** | Per reminder, individually checkable. |
| **Search** | Across titles, notes, tags and subtasks, in every list at once. |
| **Sorting** | Manual (with reorder controls), due date, creation date, priority or title, per list. |

Completing a **repeating** reminder advances it to its next occurrence rather
than closing it, exactly as iOS does. It only completes for real once the
repeat's end date has passed.

### What it deliberately does not do

These are iOS Reminders features that a web app on iOS cannot implement, not
things left for later. None of them have a workaround:

- **Location reminders** ("when I get home"). Geofencing needs background
  location, which iOS gives no web API for.
- **"When messaging" reminders.** No API exists.
- **Siri, Shortcuts, widgets, and the Lock Screen complications.** Native only.
- **Shared lists and collaboration.** There is no server-side data store — the
  Worker holds push subscriptions and a notification queue, nothing else.
- **iCloud sync between devices.** Same reason. Export/import is the only
  bridge, as it already was for the day log.
- **Buttons on the notification itself** ("Mark as Completed" from the Lock
  Screen). iOS web push does not support notification actions — a documented
  constraint of this app since before reminders existed. Tapping the
  notification opens the app directly on that reminder instead.
- **Attachments and photos.** Everything lives in `localStorage`, which is a few
  megabytes.

### How reminders become notifications

The Worker is a dumb queue: one KV entry per notification, swept once a minute,
deleted after sending. It knows nothing about repeat rules. So the **client
expands a repeating reminder into its next occurrences and queues them all**,
re-topping-up the window every time the app is opened.

```
reminder ──▶ occurrenceSeries()  ──▶  up to 24 pushes, max 120 days out
                                       tag: rem-<itemId>-<occurrenceMs>
                                             │
                                    POST /schedule (one per occurrence)
                                             │
                                     the existing pipeline
```

The alternative was teaching the Worker about recurrence, which would have meant
a second implementation of the date arithmetic in `recur.js` — in TypeScript, in
a runtime with no reachable logs, deployed separately from the app. The
expansion is bounded by whichever of 24 occurrences or 120 days comes first, but
always yields at least one, so a yearly reminder is never dropped for being far
away.

**The trade-off, stated plainly:** a repeating reminder keeps firing for as long
as its queued window covers — about three weeks for a daily one — and the app
must be opened within that window to extend it. Non-repeating reminders are a
single push and are unaffected however far out they are.

Re-queueing everything on every launch would be dozens of round-trips, so each
reminder carries a **`pushSig`** fingerprint of the fields that affect delivery
(due time, repeat, early alert, title, notes, list, priority). Reconciling skips
anything whose fingerprint is unchanged. Editing a reminder always cancels its
whole tag prefix before re-queueing, so occurrences cannot accumulate.

Settings → **Re-queue all reminders** forces a full rebuild and reports how many
notifications were queued.

## Deploying

**App:** push to `main`. GitHub Pages builds automatically. The service worker is
network-first for app code, so changes land on the next launch. Bump
`CACHE_NAME` whenever the precache list itself changes.

> **Expect the first launch after a deploy to be a mixed build.** Network-first
> falls back to the cache after 3 seconds, per file — so a slow launch can serve
> a fresh `index.html` next to a cached `js/ui.js`. That is not theoretical: the
> deploy that added the Reminders tab shipped six tab buttons alongside a cached
> `ui.js` that had five views, and tapping the new tab silently rendered Home.
>
> Three defences now exist. A tab with no view renders an explicit "this build is
> out of date" card with a reload button instead of falling through to Home
> (`renderStaleBuild()` in `ui.js`). A worker that takes over a page it did not
> start with triggers one bounded reload (`version.js`). And Settings →
> diagnostics shows **App build** next to **Service worker cache**; if those
> disagree with what was deployed, that is the failure.
>
> Bump `APP_VERSION` in `config.js` alongside `CACHE_NAME` so the readout means
> something.

**Worker:** from `worker/`, run `npx wrangler deploy`. Requires the KV namespace
id in `wrangler.toml` and three secrets:

| Secret | Notes |
| --- | --- |
| `VAPID_PUBLIC_KEY` | 87-char base64url (65 bytes, `0x04` prefix) |
| `VAPID_PRIVATE_JWK` | Full private JWK as JSON |
| `VAPID_SUBJECT` | Must be a `mailto:` or `https:` URL — Apple rejects otherwise |

Cloudflare secrets are **write-only**; a value can be replaced but never read
back. Rotating `VAPID_PUBLIC_KEY` invalidates every existing push subscription —
devices must re-subscribe via Settings → Disable → Enable, and stale `sub:`
entries should be deleted from KV by hand.

`workerd` requires macOS 13.5+. On older macOS, `wrangler deploy` generally still
works (it does not start the runtime); if it refuses, use the dashboard code
editor — see `worker/DASHBOARD-PATCH.md`.

---

## What was fixed — 2026-07-25

The app was built around March 2026 with GPT-4.x assistance. Push notifications
had never worked. One feature was removed and several real bugs corrected.

### Push notifications: five stacked failures

Not one notification had ever been delivered since the app was built. Five
independent faults, each hiding the one beneath it:

1. **A silent 5pm cutoff.** `schedulePush` returned early for any send time at or
   after 17:00 local — no toast, no log, no return value. Evening testing
   scheduled nothing and reported nothing.
2. **Permission requested outside the user gesture.** The enable flow awaited
   service-worker registration *before* calling `Notification.requestPermission()`,
   which WebKit rejects. First-time enable could not succeed on iOS.
3. **No `r.ok` check anywhere.** Every Worker call ignored the response status, so
   a 404 was indistinguishable from success.
4. **The Worker called its push library with the wrong argument names.**
   `buildPushHTTPRequest` takes `{ privateJWK, message, subscription }`; the call
   passed `{ subscription, vapid, payload }`. `privateJWK` was `undefined` and
   validation threw on `jwk.kty` **before any network request was made.** The call
   also read `req.url` / `req.method`, but the library returns
   `{ endpoint, body, headers }`.
5. **A bare `catch` that deleted the subscription.** Any error — including the
   TypeError above — caused `sub:<deviceId>` to be deleted from KV. Every attempt
   both failed to notify *and* destroyed the device's subscription.

Cloudflare reported **zero errors** throughout, because the bare `catch` swallowed
the exception. KV showed **no queued notifications**, because the cron consumed
and deleted them within 60 seconds. Both facts made the system look healthy.

**Fixed:** cutoff removed; permission requested synchronously; all Worker calls
routed through one helper that checks `r.ok` and throws with the status and body;
the Worker's library call corrected; subscriptions now deleted only on a 404/410
from the push service, the only response that actually means "gone."

**Verified working end to end on device.**

### Other corrections

- **`dayKey()` rolled over at the wrong hour.** It subtracted 4 hours then read
  the date via `toISOString()` — which is UTC. The 4am offset only landed
  correctly at UTC+0. Measured actual rollover: **midnight** in US Eastern in
  summer, **11pm** in winter, 9pm in Los Angeles, 1pm in Tokyo, 4:45pm in
  Chatham. Now reads the local wall-clock hour and steps the calendar date back.
  Verified at exactly 04:00 in eleven timezones, across month, year, leap-day,
  and both DST transitions.

- **Cache-first service worker.** Deployed changes were never picked up until
  `CACHE_NAME` was bumped by hand. Now network-first for app code with a 3s
  timeout falling back to cache, cache-first for icons, and cross-origin and
  non-GET requests are no longer intercepted at all — Worker API calls bypass the
  cache entirely.

- **`pushEnabled` could go stale.** It lived only in `localStorage`; if cleared,
  the flag reset to `false` while a live subscription still existed server-side,
  silently disabling all scheduling. Now reconciled against the browser's actual
  subscription on boot.

- **State could crash startup.** No defaults merge on load, and import replaced
  state wholesale unvalidated. Both now go through `normalizeState()`.

- **`notificationclick` opened duplicate windows.** It matched on the literal
  string `"index.html"`, which never matches the PWA's launch URL. Now matches on
  registration scope.

- Notifications now carry an icon and badge.

### Removed

- **Time blocks** (~128 lines across 8 sites). Block 1/2/3 check-ins, the block
  scheduling, the "Block reminders" card, snooze handling, and the last
  `window.prompt()` in the app. Events are now pure timestamp logging. Also
  removed `CHECKIN_OFFSET_MIN = 1`, a debug value that had shipped to production.

- **Dead code and scar tissue.** `getPushSubscription`, `buildDrumItems`,
  `VISIBLE_ITEMS`, a `0x04` VAPID prefix patch that could never fire, and the
  `FIX 1/2/3/4` comments — which described edits made in a past chat session
  rather than the code.

### Structural

- `app.js` went from a single 1,050-line file in global scope to a 41-line entry
  point plus nine focused modules.
- The Worker source, which existed **only** on Cloudflare with no backup, was
  recovered from the deployed bundle and committed to `worker/`.
- Added a notification diagnostics panel: local-notification and round-trip test
  buttons, a live environment readout, and a persisted last-result block — a
  1.6s toast is unreadable on a phone and iOS has no reachable console.

**Commits:** `4698c86`, `930dc3d`, `978f0ab`, `81cadf8`, `6c8080c`, `94398dd`,
`318dd5a`, `631d41e`.

---

## Things to know before changing anything

- **Do not reintroduce silent returns.** Every failure path should toast or log
  something specific. Three months of "notifications don't work" came from code
  that failed quietly, and `VIEWS[currentTab] || renderHome` later hid a broken
  deploy the same way. A fallback that renders *something* is still a silent
  failure.
- **`Notification.requestPermission()` must stay synchronous** in the click
  handler. Adding an `await` above it breaks iOS enable, and the failure looks
  like a permission denial.
- **`dayKey()` is subtler than it looks.** Never do date arithmetic in UTC here.
  It has been wrong once already and the symptom was invisible.
- **Never delete a push subscription on a generic error.** Only 404/410 from the
  push service means it is actually gone.
- **The service worker must not intercept the Worker API.** Cross-origin and
  non-GET requests bypass it deliberately.
- **Views are string templates written into `innerHTML`.** Any user-controlled
  text must go through `escapeHtml()`.
- Text inputs deliberately **do not** trigger a re-render — that would destroy
  the element being typed into. `data-action-kind` picks the behaviour:
  `input` (save, no re-render), `live` (save and re-render, restoring focus and
  caret), `change`, `submit` (Enter), or the default `click`.
- **All reminder date arithmetic goes through `reminders/recur.js`,** and all of
  it is local wall-clock. Adding 24h is not "the next day": a 9am daily reminder
  has to stay at 9am on both sides of a DST change. `new Date("2026-03-04")` is
  UTC midnight and lands on the 3rd for anyone west of Greenwich — parse date
  input values field by field, which `fromDateInputValue()` does.
- **Cancel before scheduling.** The Worker stores one KV entry per push with no
  notion of replacing one, so re-queueing without `cancelPushPrefix()` first
  leaves duplicates behind.
- **Reminder push tags are `rem-<itemId>-<occurrenceMs>`.** The trailing dash on
  the `rem-<itemId>-` prefix matters — it is what makes cancelling one
  reminder's series unambiguous.
- **`Number(null)` is `0`, and `0,0` is a real place.** Both the weather
  summariser and the location normaliser reject non-numbers explicitly rather
  than leaning on `Number.isFinite()`, because coercion turns "no data" into a
  reading: a missing chance of precipitation became "Rain 0%", and an unset
  location became a point in the Gulf of Guinea. Both were caught by tests, not
  by looking at the code.
- **The weather providers are called from the page, not through the Worker.**
  They are keyless public GETs; a hop through the Worker would only add
  something else that can fail. The service worker ignores cross-origin
  requests, so nothing caches them but `service.js`.
- **`render()` never awaits the weather.** The banner paints from cache and a
  refresh re-renders when it lands. Anything that makes the first paint wait on
  the network is a regression.
- **Run the tests with an explicit `TZ`.** See [Tests](#tests).

---

## Known limitations

- **Single device.** `deviceId` is per-install; state does not sync. Two devices
  are two separate logbooks. Export/import is the only bridge.
- **`localStorage` is the only copy.** No server-side backup of app data. Export
  regularly.
- **Notification timing is ±1–2 minutes.** Reminders inherit this: an alert set
  for 9:00 arrives at 9:00–9:02. Fine for what this app is for; do not rely on
  it for anything time-critical.
- **Repeating reminders need the app opened every few weeks** to extend their
  queued window — see [How reminders become notifications](#how-reminders-become-notifications).
- **No DOM tests.** The date logic, parser, store and weather summariser are
  covered; the views are not.
- **The weather needs a location and a connection.** Coverage for the official
  alerts and the NWS forecast is the US and its territories; elsewhere the
  banner falls back to Open-Meteo and loses the alerts. With no connection it
  shows the last forecast it fetched, stamped with the time.
- **Full re-render on every action** — fine at this size, would not scale.

## Open items

- `/sendNow` and `/debug` on the Worker are **unauthenticated**. Anyone who
  learned the device ID could push a notification to the phone. A shared secret
  between app and Worker would close this.
- The ticker `setInterval` runs even when the tab is hidden.
- Reordering reminders uses ↑/↓ buttons rather than drag-and-drop, which does
  not survive the full re-render on every action.
- An import replaces state wholesale, so notifications queued for the *previous*
  state's reminder ids are orphaned in KV until they fire. They are harmless —
  the reminder they name is gone — but they do fire once.
- `worker/` is published as part of the Pages site (harmless — no secrets — but a
  separate repo would be cleaner).
