#!/usr/bin/env node
/**
 * Generates a fresh VAPID keypair for 90dwp-push.
 *
 * Usage:  node generate-vapid.mjs
 *
 * Prints the two secret values to set on the Worker. Run this locally and
 * paste the values straight into Cloudflare — the private key should never
 * pass through a chat, an email, or a commit.
 *
 * Changing the keypair invalidates every existing push subscription. Devices
 * simply re-subscribe (Settings -> Disable -> Enable), and any stale sub:
 * entries left in KV should be deleted by hand.
 */
import { generateKeyPairSync } from "node:crypto";

const b64uToBuf = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const bufToB64u = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });

// Web push wants the public key as a raw uncompressed P-256 point: 0x04 || X || Y.
const publicRaw = Buffer.concat([
  Buffer.from([0x04]),
  b64uToBuf(jwk.x),
  b64uToBuf(jwk.y)
]);
const publicKey = bufToB64u(publicRaw);

const privateJwk = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: jwk.x,
  y: jwk.y,
  d: jwk.d
});

if (publicRaw.length !== 65 || publicKey.length !== 87) {
  console.error(`Unexpected key size: ${publicRaw.length} bytes / ${publicKey.length} chars`);
  process.exit(1);
}

console.log(`
Set these two secrets on the Worker.
Dashboard -> Workers & Pages -> 90dwp-push -> Settings -> Variables and Secrets
(or: npx wrangler secret put <NAME>)

────────────────────────────────────────────────────────────────
VAPID_PUBLIC_KEY   (rotate the existing secret to this value)
────────────────────────────────────────────────────────────────
${publicKey}

────────────────────────────────────────────────────────────────
VAPID_PRIVATE_JWK  (add as a new secret — keep this private)
────────────────────────────────────────────────────────────────
${privateJwk}

────────────────────────────────────────────────────────────────
VAPID_SUBJECT      (add if not already set)
────────────────────────────────────────────────────────────────
mailto:your@email.address

The old VAPID_PRIVATE_KEY secret is no longer read by the worker and can
be deleted once the new values are in place.
`);
