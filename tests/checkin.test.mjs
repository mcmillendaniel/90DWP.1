/**
 * The daily morning check-in push: when it fires, and how the queue is topped up.
 *
 * Run with:  TZ=America/New_York node --test "tests/*.test.mjs"
 *
 * Worker calls are captured by a fetch stub, so nothing touches the network.
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
  _store: new Map(),
  getItem(k){ return this._store.has(k) ? this._store.get(k) : null; },
  setItem(k, v){ this._store.set(k, String(v)); },
  removeItem(k){ this._store.delete(k); },
  clear(){ this._store.clear(); }
};
globalThis.location = { origin: "https://example.test", pathname: "/app/" };

const calls = [];
let workerUp = true;
globalThis.fetch = async (url, init) => {
  calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
  return workerUp
    ? new Response("{\"ok\":true}", { status: 200 })
    : new Response("down", { status: 503 });
};

const stateMod = await import("../js/state.js");
const checkin = await import("../js/checkin.js");

const at = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

function reset(settings = { pushEnabled: true }){
  stateMod.replaceState({ days: {}, settings, reminders: null });
  calls.length = 0;
  workerUp = true;
}
const scheduled = () => calls.filter(c => c.path === "/schedule");

test("defaults to on with nothing queued", () => {
  reset({});
  assert.deepEqual(stateMod.state.settings.checkin, { enabled: true, queuedThrough: null });
});

test("first check-in is today at 5am if that is still ahead", () => {
  const times = checkin.checkinTimes(at(2026, 10, 2, 3, 0), 2);
  assert.equal(times[0].sendAt, at(2026, 10, 2, 5, 0));
  assert.equal(times[0].tag, "checkin-2026-10-02");
  assert.equal(times[1].sendAt, at(2026, 10, 3, 5, 0));
});

test("first check-in is tomorrow once 5am has passed", () => {
  const times = checkin.checkinTimes(at(2026, 10, 2, 5, 0), 1);
  assert.equal(times[0].sendAt, at(2026, 10, 3, 5, 0));
});

test("stays at 5am local across the DST change", () => {
  // US clocks fall back on 2026-11-01.
  const times = checkin.checkinTimes(at(2026, 10, 31, 12), 3);
  for(const { sendAt } of times){
    const d = new Date(sendAt);
    assert.equal(d.getHours(), 5);
    assert.equal(d.getMinutes(), 0);
  }
  assert.deepEqual(times.map(t => t.tag), ["checkin-2026-11-01", "checkin-2026-11-02", "checkin-2026-11-03"]);
});

test("queues three weeks of check-ins that open the Morning tab", async () => {
  reset();
  const n = await checkin.reconcileCheckin({ now: at(2026, 10, 2, 9) });
  assert.equal(n, 21);
  const first = scheduled()[0].body;
  assert.equal(first.tag, "checkin-2026-10-03");
  assert.equal(first.sendAt, at(2026, 10, 3, 5));
  assert.equal(first.title, "Don't forget to Check In!");
  assert.equal(first.url, "https://example.test/app/#tab/morning");
  assert.equal(stateMod.state.settings.checkin.queuedThrough, at(2026, 10, 23, 5));
});

test("an ordinary launch makes no Worker calls while the window is full", async () => {
  reset();
  await checkin.reconcileCheckin({ now: at(2026, 10, 2, 9) });
  calls.length = 0;
  assert.equal(await checkin.reconcileCheckin({ now: at(2026, 10, 5, 9) }), 0);
  assert.equal(calls.length, 0);
});

test("tops up only the new mornings once the window runs low", async () => {
  reset();
  await checkin.reconcileCheckin({ now: at(2026, 10, 2, 9) });
  calls.length = 0;
  // Ten days on, only 11 mornings remain queued — below the refill mark.
  const n = await checkin.reconcileCheckin({ now: at(2026, 10, 12, 9) });
  assert.equal(n, 10);
  assert.equal(scheduled()[0].body.tag, "checkin-2026-10-24");
  assert.equal(stateMod.state.settings.checkin.queuedThrough, at(2026, 11, 2, 5));
});

test("does nothing while push is off", async () => {
  reset({ pushEnabled: false, checkin: { enabled: true, queuedThrough: at(2026, 10, 9, 5) } });
  assert.equal(await checkin.reconcileCheckin({ now: at(2026, 10, 2, 9) }), 0);
  assert.equal(calls.length, 0);
  assert.equal(stateMod.state.settings.checkin.queuedThrough, null);
});

test("turning it off cancels the queued check-ins", async () => {
  reset();
  await checkin.reconcileCheckin({ now: at(2026, 10, 2, 9) });
  calls.length = 0;
  await checkin.setCheckinEnabled(false);
  assert.deepEqual(calls.map(c => c.path), ["/cancelPrefix"]);
  assert.equal(calls[0].body.prefix, "checkin-");
  assert.equal(stateMod.state.settings.checkin.queuedThrough, null);
});

test("a Worker failure stops early and retries next launch", async () => {
  reset();
  workerUp = false;
  assert.equal(await checkin.reconcileCheckin({ now: at(2026, 10, 2, 9) }), 0);
  assert.equal(scheduled().length, 1);
  assert.equal(stateMod.state.settings.checkin.queuedThrough, null);
});
