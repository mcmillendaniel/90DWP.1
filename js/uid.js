/**
 * Id generation, in its own module so the reminders schema can use it without
 * importing state.js — state.js normalizes through the schema, and the two
 * importing each other would close a dependency cycle.
 */
export function safeUUID(){
  if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
