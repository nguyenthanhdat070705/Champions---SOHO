// Functional 08 — private object storage access (spec 7 / 9.4 / 12.2).
// The server never holds a service_role key; instead it acts on the caller's
// behalf with THEIR JWT, so Supabase Storage RLS still applies. The `documents`
// bucket's policy requires the object key's first path segment to be a merchant
// the caller is an ACTIVE member of, so keys are ALWAYS `${merchantId}/${uuid}.${ext}`
// (also keeps PII out of the key — spec 12.2). Signed URLs are short-lived and
// generated only after the membership/status/purpose check + access audit.
import { createClient } from "@supabase/supabase-js";
import { supabaseAnonKey, supabaseUrl } from "../f3/env.js";
import { fail } from "../f3/errors.js";

export const BUCKET = "documents";
export const SIGNED_URL_TTL = 120; // seconds — short-lived (spec 3.5 / 10 no-store)

/** A Supabase client scoped to the caller's JWT (Storage RLS enforced). */
function clientForToken(token) {
  return createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Upload bytes to `${merchantId}/...`. Throws STORAGE_ERROR on failure. */
export async function uploadObject(token, objectKey, buffer, mimeType) {
  const sb = clientForToken(token);
  const { error } = await sb.storage.from(BUCKET).upload(objectKey, buffer, {
    contentType: mimeType, upsert: false,
  });
  if (error) fail("STORAGE_ERROR", `Không lưu được tệp: ${error.message}`);
}

/** Best-effort delete (used to avoid an orphan object if the DB insert fails). */
export async function removeObject(token, objectKey) {
  try {
    await clientForToken(token).storage.from(BUCKET).remove([objectKey]);
  } catch { /* best-effort; a rare orphan is preferable to a failed rollback */ }
}

/** Short-lived signed URL for a single object (detail / download). */
export async function signOne(token, objectKey, ttl = SIGNED_URL_TTL) {
  const sb = clientForToken(token);
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(objectKey, ttl);
  if (error) fail("STORAGE_ERROR", `Không tạo được liên kết xem: ${error.message}`);
  return data.signedUrl;
}

/**
 * Batch signed URLs for list thumbnails (one storage round-trip for the page).
 * Returns a Map<objectKey, signedUrl>; missing/failed keys are simply absent.
 * Thumbnails are previews, not an "open document" action, so they are NOT audited.
 */
export async function signMany(token, objectKeys, ttl = SIGNED_URL_TTL) {
  const out = new Map();
  const keys = objectKeys.filter(Boolean);
  if (keys.length === 0) return out;
  const sb = clientForToken(token);
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(keys, ttl);
  if (error || !data) return out; // degrade gracefully — cards fall back to a placeholder
  for (const row of data) {
    if (row.signedUrl && !row.error) out.set(row.path, row.signedUrl);
  }
  return out;
}
