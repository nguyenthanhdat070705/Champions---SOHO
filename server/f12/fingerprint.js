// Functional 12 — deterministic fingerprint + evidence content hash (spec 4.2 /
// 9.1). PURE (no DB, no clock) so the golden/determinism tests can pin them.
//
//   • fingerprint  = sha256(rule_id | rule_version | canonical entity key). It
//     contains ONLY rule identity + entity ids (no PII, no amounts) so the same
//     mismatch across reruns yields the SAME fingerprint → one active issue
//     (the recon_one_active_fingerprint partial unique index dedupes).
//   • contentHash  = sha256(canonical JSON of the evidence facts). Two runs that
//     see identical facts produce the same hash → evidence is appended once, not
//     duplicated; a changed hash records genuine drift (evidence is insert-only).
import { createHash } from "node:crypto";

/**
 * Canonicalize a JSON value so key order / whitespace never change the hash.
 * Objects → keys sorted; arrays preserve order; scalars pass through. Undefined
 * object entries are dropped (JSON.stringify would anyway) for stable output.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalize(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

/** Canonical JSON string (sorted keys) — the pre-image for every hash. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Stable fingerprint for a rule match. `entityKey` is a canonical, PII-free
 * identifier for the mismatching entity set, e.g. "order:<uuid>" or
 * "product:<uuid>". Different rules on the same entity → different fingerprints.
 */
export function fingerprint(ruleId, ruleVersion, entityKey) {
  return sha256(`${ruleId}|${ruleVersion}|${entityKey}`);
}

/** Content hash of an evidence facts object (immutability + dedupe). */
export function contentHash(facts) {
  return sha256(canonicalJson(facts));
}
