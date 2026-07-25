/**
 * 90DWP push worker.
 *
 * Routes:
 *   GET  /vapidPublicKey  -> { publicKey }
 *   POST /subscribe       -> stores sub:<deviceId>
 *   POST /schedule        -> stores sched:<deviceId>:<tag>:<id>
 *   POST /cancelPrefix    -> deletes sched:<deviceId>:<prefix>*
 *   GET  /debug           -> counts, for diagnosing without a log tail
 *   POST /sendNow         -> immediate send, bypasses the cron entirely
 *
 * A cron trigger (* * * * *) drives scheduled().
 */
import { buildPushHTTPRequest } from "@pushforge/builder";

export interface Env {
  PUSH_KV: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  /** Full private JWK as JSON: {"kty":"EC","crv":"P-256","x":..,"y":..,"d":..} */
  VAPID_PRIVATE_JWK: string;
  /** JWT `sub` claim. Must be a mailto: or https: URL. */
  VAPID_SUBJECT: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface ScheduledItem {
  id: string;
  deviceId: string;
  tag: string;
  title: string;
  body: string;
  sendAt: number;
  url: string;
  kind: string | null;
  actions: unknown[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return corsPreflight();
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/vapidPublicKey") {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    // Counts only — never returns key material or subscription contents.
    if (request.method === "GET" && url.pathname === "/debug") {
      const subs = await env.PUSH_KV.list({ prefix: "sub:" });
      const sched = await env.PUSH_KV.list({ prefix: "sched:" });
      return json({
        ok: true,
        now: Date.now(),
        subscriptions: subs.keys.length,
        scheduled: sched.keys.length,
        pending: sched.keys.map((k) => k.name),
        config: {
          hasPublicKey: !!env.VAPID_PUBLIC_KEY,
          hasPrivateJwk: !!env.VAPID_PRIVATE_JWK,
          subject: env.VAPID_SUBJECT || null
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/subscribe") {
      const { deviceId, subscription } = await request.json<any>();
      if (!deviceId || !subscription) {
        return json({ ok: false, error: "missing deviceId/subscription" }, 400);
      }
      await env.PUSH_KV.put(`sub:${deviceId}`, JSON.stringify(subscription));
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/schedule") {
      const payload = await request.json<any>();
      const { deviceId, tag, title, body, sendAt, url: clickUrl, kind, actions } = payload || {};
      if (!deviceId || !tag || !title || !body || !sendAt) {
        return json({ ok: false, error: "missing fields" }, 400);
      }
      const id = crypto.randomUUID();
      const item: ScheduledItem = {
        id,
        deviceId,
        tag,
        title,
        body,
        sendAt: Number(sendAt),
        url: clickUrl || "/",
        kind: kind || null,
        actions: Array.isArray(actions) ? actions : []
      };
      await env.PUSH_KV.put(`sched:${deviceId}:${tag}:${id}`, JSON.stringify(item));
      return json({ ok: true, id });
    }

    // Sends immediately and reports the push service's real response, so a
    // delivery failure is visible in one request instead of via the cron.
    if (request.method === "POST" && url.pathname === "/sendNow") {
      const { deviceId, title, body } = await request.json<any>();
      if (!deviceId) return json({ ok: false, error: "missing deviceId" }, 400);
      const subRaw = await env.PUSH_KV.get(`sub:${deviceId}`);
      if (!subRaw) return json({ ok: false, error: `no subscription for ${deviceId}` }, 404);
      const result = await sendPush(env, JSON.parse(subRaw), {
        title: title || "90DWP",
        body: body || "Immediate test.",
        url: "/",
        tag: `sendnow-${Date.now()}`,
        actions: []
      });
      return json({ ok: result.ok, status: result.status, detail: result.detail }, result.ok ? 200 : 502);
    }

    if (request.method === "POST" && url.pathname === "/cancelPrefix") {
      const { deviceId, prefix } = await request.json<any>();
      if (!deviceId || !prefix) return json({ ok: false, error: "missing deviceId/prefix" }, 400);
      const list = await env.PUSH_KV.list({ prefix: `sched:${deviceId}:${prefix}` });
      await Promise.all(list.keys.map((k) => env.PUSH_KV.delete(k.name)));
      return json({ ok: true, deleted: list.keys.length });
    }

    return json({ ok: false, error: "not found" }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDue(env));
  }
};

/**
 * Builds and sends one push. Returns the outcome rather than throwing, so the
 * caller can distinguish "this subscription is gone" from "something broke".
 */
async function sendPush(
  env: Env,
  subscription: any,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number; detail: string; gone: boolean }> {
  try {
    // Argument names must match the library exactly: privateJWK + message.
    // Passing `vapid`/`payload` leaves privateJWK undefined, which throws
    // inside validatePrivateJWK before any network call happens.
    const req = await buildPushHTTPRequest({
      privateJWK: env.VAPID_PRIVATE_JWK,
      subscription,
      message: {
        payload,
        adminContact: env.VAPID_SUBJECT,
        options: { ttl: 12 * 60 * 60, urgency: "high" }
      }
    });

    // The library returns { endpoint, body, headers } — there is no .url or
    // .method on it, so both must be supplied here.
    const res = await fetch(req.endpoint, {
      method: "POST",
      headers: req.headers,
      body: req.body
    });

    const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    if (!res.ok) console.error(`[push] ${res.status} from push service: ${detail}`);
    // 404/410 are the only responses that actually mean the subscription is dead.
    return { ok: res.ok, status: res.status, detail, gone: res.status === 404 || res.status === 410 };
  } catch (e: any) {
    console.error("[push] send threw:", e?.message || e);
    return { ok: false, status: 0, detail: String(e?.message || e), gone: false };
  }
}

async function processDue(env: Env): Promise<void> {
  const now = Date.now();
  const list = await env.PUSH_KV.list({ prefix: "sched:" });
  if (!list.keys.length) return;

  for (const key of list.keys) {
    const raw = await env.PUSH_KV.get(key.name);
    if (!raw) continue;

    let item: ScheduledItem;
    try {
      item = JSON.parse(raw);
    } catch {
      await env.PUSH_KV.delete(key.name);
      continue;
    }

    if (!item?.sendAt || item.sendAt > now) continue;

    const subRaw = await env.PUSH_KV.get(`sub:${item.deviceId}`);
    if (!subRaw) {
      await env.PUSH_KV.delete(key.name);
      continue;
    }

    let subscription: any;
    try {
      subscription = JSON.parse(subRaw);
    } catch {
      await env.PUSH_KV.delete(`sub:${item.deviceId}`);
      await env.PUSH_KV.delete(key.name);
      continue;
    }

    const result = await sendPush(env, subscription, {
      title: item.title,
      body: item.body,
      url: item.url,
      tag: item.tag,
      kind: item.kind,
      actions: item.actions || []
    });

    // Only drop the subscription when the push service says it is gone.
    // The previous version deleted it on ANY error, which silently destroyed
    // a working subscription on every single failed send.
    if (result.gone) {
      console.warn(`[push] subscription gone (${result.status}), removing sub:${item.deviceId}`);
      await env.PUSH_KV.delete(`sub:${item.deviceId}`);
    }

    await env.PUSH_KV.delete(key.name);
  }
}
