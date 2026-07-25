# 90dwp-push

Cloudflare Worker backing 90DWP's web push. A cron trigger (`* * * * *`) sweeps
KV for due notifications and sends them via VAPID.

## The bug this fixes

`processDue()` called the push library with the wrong argument names:

```js
buildPushHTTPRequest({ subscription, vapid, payload })   // wrong
buildPushHTTPRequest({ privateJWK, message, subscription })  // what it wants
```

`privateJWK` was therefore `undefined`, and `validatePrivateJWK()` threw on
`jwk.kty` before any network call happened. The surrounding `catch` then
deleted the device's subscription from KV on every failure, so each attempt
both failed to notify *and* destroyed the subscription. Cloudflare reported
zero errors throughout, because the bare `catch` swallowed the TypeError.

Separately, the call read `req.url` / `req.method`, but the library returns
`{ endpoint, body, headers }` — both were `undefined`.

## Secrets

| Name | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | Unchanged. 87-char base64url (65 bytes, `0x04` prefix). |
| `VAPID_PRIVATE_JWK` | **New.** Full private JWK as JSON. |
| `VAPID_SUBJECT` | `mailto:you@example.com` — must be `mailto:` or `https:`. |

`VAPID_PRIVATE_JWK` replaces `VAPID_PRIVATE_KEY`, which the worker no longer
reads.

Cloudflare secrets are write-only — an existing private key cannot be read
back, only replaced. So unless the original keypair was saved somewhere,
generate a fresh one:

```bash
node generate-vapid.mjs
```

Run it locally and paste the values straight into Cloudflare. The private key
should never pass through a chat, an email, or a commit.

If you *do* still have the original raw keypair, `vapid-to-jwk.mjs` converts it
instead, preserving existing subscriptions:

```bash
node vapid-to-jwk.mjs "<VAPID_PUBLIC_KEY>" "<VAPID_PRIVATE_KEY>"
```

Either way, changing the public key invalidates existing subscriptions. Devices
re-subscribe via Settings -> Disable -> Enable, and stale `sub:` entries left in
KV should be deleted by hand.

## Deploy

```bash
npm install
npx wrangler secret put VAPID_PRIVATE_JWK
npx wrangler secret put VAPID_SUBJECT
npx wrangler deploy
```

Set the `PUSH_KV` namespace id in `wrangler.toml` first.

**On macOS below 13.5**, `wrangler dev` cannot run — the `workerd` runtime
requires 13.5+. `wrangler deploy` does not start `workerd` and generally still
works. If it refuses, edit and deploy from the dashboard code editor instead;
see `DASHBOARD-PATCH.md`.

## Diagnosing

`GET /debug` returns subscription and scheduled counts plus which config values
are present. It never returns key material.

`POST /sendNow {"deviceId":"..."} ` sends immediately and returns the push
service's actual status code and body, bypassing the cron entirely. This turns
a delivery failure into one visible HTTP response instead of something you have
to infer from a log tail.
