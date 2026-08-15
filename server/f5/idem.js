// In-process idempotency single-flight for F05 posts (spec 5.1 / 10.3). Mirrors
// the F04 catalog approach: a durable key table would need a migration (out of
// scope for the pilot). A same-key + same-body double-tap replays the SAME result;
// a same-key + different-body call is a 409. This guards the fast double-tap;
// durable cross-restart dedup rides on the movement's unique (product, type, ref)
// index (see server/f5/movements.js deterministicUuid).
import { createHash } from "node:crypto";
import { fail } from "../f3/errors.js";

const store = new Map(); // `${scope}:${key}` -> { hash, promise, result, expires }
const TTL_MS = 15 * 60 * 1000;

export function bodyHash(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

export async function runIdempotent(scope, key, hash, fn) {
  if (!key) return { result: await fn(), replayed: false };
  const id = `${scope}:${key}`;
  const now = Date.now();
  for (const [k, v] of store) if (v.expires < now) store.delete(k);
  const existing = store.get(id);
  if (existing) {
    if (existing.hash !== hash) fail("IDEMPOTENCY_PAYLOAD_MISMATCH");
    if (existing.result !== undefined) return { result: existing.result, replayed: true };
    return { result: await existing.promise, replayed: true };
  }
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // no unhandledRejection when nobody awaits
  store.set(id, { hash, promise, result: undefined, expires: now + TTL_MS });
  try {
    const result = await fn();
    const e = store.get(id);
    if (e) { e.result = result; e.expires = Date.now() + TTL_MS; }
    resolve(result);
    return { result, replayed: false };
  } catch (err) {
    store.delete(id); // a failed attempt may be retried with the same key
    reject(err);
    throw err;
  }
}
