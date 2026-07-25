#!/usr/bin/env node
/**
 * Converts a raw base64url VAPID keypair into the private JWK that
 * @pushforge/builder requires.
 *
 * Usage:  node vapid-to-jwk.mjs <VAPID_PUBLIC_KEY> <VAPID_PRIVATE_KEY>
 *
 * Keeps the SAME keypair, so existing push subscriptions stay valid.
 * Generating a new pair would invalidate every device already subscribed.
 */
const [pub, priv] = process.argv.slice(2);
if (!pub || !priv) {
  console.error("usage: node vapid-to-jwk.mjs <publicKey> <privateKey>");
  process.exit(1);
}

const b64uToBuf = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const bufToB64u = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

const pubBytes = b64uToBuf(pub);
if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
  console.error(`Public key must be 65 bytes starting with 0x04; got ${pubBytes.length} bytes starting 0x${pubBytes[0].toString(16)}`);
  process.exit(1);
}
const d = b64uToBuf(priv);
if (d.length !== 32) {
  console.error(`Private key must be 32 bytes; got ${d.length}. If it is already JSON, you may already have a JWK.`);
  process.exit(1);
}

const jwk = {
  kty: "EC",
  crv: "P-256",
  x: bufToB64u(pubBytes.subarray(1, 33)),
  y: bufToB64u(pubBytes.subarray(33, 65)),
  d: bufToB64u(d)
};

// Prove the pair is mathematically consistent before printing it.
const { createPrivateKey, createPublicKey } = await import("node:crypto");
const key = createPrivateKey({ key: jwk, format: "jwk" });
const derived = createPublicKey(key).export({ format: "jwk" });
if (derived.x !== jwk.x || derived.y !== jwk.y) {
  console.error("MISMATCH: this private key does not correspond to that public key.");
  process.exit(1);
}
console.error("✓ keypair verified consistent\n");
console.log(JSON.stringify(jwk));
