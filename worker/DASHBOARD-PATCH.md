# Deploying without wrangler (macOS < 13.5)

If `wrangler deploy` refuses to run, the fix can be applied directly in the
Cloudflare dashboard's code editor. The bug is entirely inside the bundled
file's `processDue` function at the very bottom — the ~2000 lines of vendored
library code above it need no changes.

Note the bundler renamed `env` to `env2` inside that section. Keep that name.

## Steps

1. Dashboard → Workers & Pages → `90dwp-push` → **Edit Code**
2. Scroll to the bottom and find `async function processDue(env2) {`
3. Replace **everything** from that line down to (but not including)
   `__name(processDue, "processDue");` with the block below
4. Click **Deploy**

Then add the two secrets under Settings → Variables and Secrets:
`VAPID_PRIVATE_JWK` and `VAPID_SUBJECT`. See `README.md` for generating the JWK.

## Replacement block

```js
async function sendPush(env2, subscription, payload) {
  try {
    const req = await buildPushHTTPRequest({
      privateJWK: env2.VAPID_PRIVATE_JWK,
      subscription,
      message: {
        payload,
        adminContact: env2.VAPID_SUBJECT,
        options: { ttl: 12 * 60 * 60, urgency: "high" }
      }
    });
    const res = await fetch(req.endpoint, {
      method: "POST",
      headers: req.headers,
      body: req.body
    });
    const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    if (!res.ok) console.error(`[push] ${res.status} from push service: ${detail}`);
    return { ok: res.ok, status: res.status, detail, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    console.error("[push] send threw:", e?.message || e);
    return { ok: false, status: 0, detail: String(e?.message || e), gone: false };
  }
}
__name(sendPush, "sendPush");

async function processDue(env2) {
  const now = Date.now();
  const list = await env2.PUSH_KV.list({ prefix: "sched:" });
  if (!list.keys.length) return;
  for (const key of list.keys) {
    const raw = await env2.PUSH_KV.get(key.name);
    if (!raw) continue;
    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      await env2.PUSH_KV.delete(key.name);
      continue;
    }
    if (!item?.sendAt || item.sendAt > now) continue;
    const subRaw = await env2.PUSH_KV.get(`sub:${item.deviceId}`);
    if (!subRaw) {
      await env2.PUSH_KV.delete(key.name);
      continue;
    }
    let subscription;
    try {
      subscription = JSON.parse(subRaw);
    } catch {
      await env2.PUSH_KV.delete(`sub:${item.deviceId}`);
      await env2.PUSH_KV.delete(key.name);
      continue;
    }
    const result = await sendPush(env2, subscription, {
      title: item.title,
      body: item.body,
      url: item.url,
      tag: item.tag,
      kind: item.kind,
      actions: item.actions || []
    });
    // Only remove the subscription when the push service says it is gone.
    // The old code deleted it on ANY error, destroying working subscriptions.
    if (result.gone) {
      console.warn(`[push] subscription gone (${result.status}), removing sub:${item.deviceId}`);
      await env2.PUSH_KV.delete(`sub:${item.deviceId}`);
    }
    await env2.PUSH_KV.delete(key.name);
  }
}
```

## Optional: the /debug route

In the same editor, inside `index_default.fetch`, immediately after the
`/vapidPublicKey` block, paste:

```js
    if (request.method === "GET" && url.pathname === "/debug") {
      const subs = await env2.PUSH_KV.list({ prefix: "sub:" });
      const sched = await env2.PUSH_KV.list({ prefix: "sched:" });
      return json({
        ok: true,
        now: Date.now(),
        subscriptions: subs.keys.length,
        scheduled: sched.keys.length,
        config: {
          hasPublicKey: !!env2.VAPID_PUBLIC_KEY,
          hasPrivateJwk: !!env2.VAPID_PRIVATE_JWK,
          subject: env2.VAPID_SUBJECT || null
        }
      });
    }
```

Then `https://90dwp-push.mcmillendaniel.workers.dev/debug` answers, in one
request, whether the secrets are set and whether anything is queued.
