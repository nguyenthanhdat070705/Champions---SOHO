// Functional 06 — private document storage (spec 3.5 / 8.3 / 12.2). Receipt
// photos are EVIDENCE, kept in a PRIVATE Supabase Storage bucket ("documents")
// and only ever served through short-lived signed URLs (REC-FR-11 / NFR
// "Ảnh private/signed URL"). Object keys are prefixed by merchant_id so the
// storage RLS policy scopes access to merchant members — a cross-tenant read is
// denied at the storage layer (REC-13).
//
// The bucket + its RLS policy are provisioned idempotently over the pooler (the
// pooler role owns storage.buckets / storage.objects). The actual byte transfer
// uses the Storage REST API with the CALLER's JWT (forwarded from the request),
// so uploads/signing ride the same merchant-scoped policy — no service_role
// secret is needed or stored.
import { getPool } from "../db/pool.js";
import { supabaseUrl } from "../f3/env.js";
import { DomainError } from "../f3/errors.js";

export const BUCKET = "documents";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024; // 10MB (spec 12.2 size limit)

let bucketReady = false;

/**
 * Ensure the private "documents" bucket + a merchant-scoped RLS policy exist.
 * Idempotent and safe to call on every upload (cheap once cached in-process).
 */
export async function ensureDocumentsBucket() {
  if (bucketReady) return;
  const pool = getPool();
  await pool.query(
    `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
       values ($1,$1,false,$2,$3)
     on conflict (id) do nothing`,
    [BUCKET, MAX_BYTES, ALLOWED_MIME],
  );
  // CREATE POLICY has no IF NOT EXISTS; check the catalog first.
  const { rows } = await pool.query(
    `select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='soho_documents_member_rw'`,
  );
  if (rows.length === 0) {
    await pool.query(
      `create policy soho_documents_member_rw on storage.objects for all to authenticated
         using ( bucket_id = '${BUCKET}' and (storage.foldername(name))[1] in (
            select merchant_id::text from public.merchant_members
             where user_id = auth.uid() and status = 'active'))
         with check ( bucket_id = '${BUCKET}' and (storage.foldername(name))[1] in (
            select merchant_id::text from public.merchant_members
             where user_id = auth.uid() and status = 'active'))`,
    );
  }
  bucketReady = true;
}

function extFor(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

/** Validate an image upload's mime + decoded size, returning the raw bytes. */
export function decodeImage(base64, mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (!ALLOWED_MIME.includes(mime)) {
    throw new DomainError("VALIDATION", "Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP.");
  }
  if (!base64 || typeof base64 !== "string") throw new DomainError("VALIDATION", "Thiếu ảnh chứng từ.");
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0) throw new DomainError("VALIDATION", "Ảnh chứng từ rỗng.");
  if (buf.length > MAX_BYTES) throw new DomainError("VALIDATION", "Ảnh quá lớn (tối đa 10MB).");
  return { buf, mime, ext: extFor(mime) };
}

/** Build the deterministic private object key for a document. */
export function objectKeyFor(merchantId, documentId, ext) {
  return `${merchantId}/${documentId}.${ext}`;
}

/**
 * Upload document bytes to the private bucket using the caller's JWT. The bytes
 * are stored under `<merchant_id>/<doc_id>.<ext>` so the RLS policy applies.
 */
export async function uploadDocument(token, objectKey, buf, mime) {
  await ensureDocumentsBucket();
  let res;
  try {
    res = await fetch(`${supabaseUrl()}/storage/v1/object/${BUCKET}/${objectKey}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mime, "x-upsert": "true" },
      body: buf,
    });
  } catch {
    throw new DomainError("STORAGE_UNAVAILABLE");
  }
  if (res.status === 403) throw new DomainError("FORBIDDEN");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("storage upload failed", res.status, body.slice(0, 200));
    throw new DomainError("STORAGE_UNAVAILABLE");
  }
}

/** Fetch document bytes back (server-side, for re-running extraction). */
export async function downloadDocument(token, objectKey) {
  let res;
  try {
    res = await fetch(`${supabaseUrl()}/storage/v1/object/authenticated/${BUCKET}/${objectKey}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new DomainError("STORAGE_UNAVAILABLE");
  }
  if (res.status === 403) throw new DomainError("FORBIDDEN");
  if (!res.ok) throw new DomainError("DOCUMENT_NOT_FOUND");
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/**
 * Create a short-lived signed URL for viewing a document (REC-FR-11). Uses the
 * caller's JWT so the merchant-scoped policy is enforced; a non-member cannot
 * sign another merchant's object.
 * @returns {Promise<string>} absolute signed URL
 */
export async function signDocumentUrl(token, objectKey, expiresIn = 300) {
  let res;
  try {
    res = await fetch(`${supabaseUrl()}/storage/v1/object/sign/${BUCKET}/${objectKey}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    });
  } catch {
    throw new DomainError("STORAGE_UNAVAILABLE");
  }
  if (res.status === 403) throw new DomainError("FORBIDDEN");
  if (!res.ok) throw new DomainError("DOCUMENT_NOT_FOUND");
  const json = await res.json().catch(() => null);
  const signed = json?.signedURL;
  if (!signed) throw new DomainError("STORAGE_UNAVAILABLE");
  return `${supabaseUrl()}/storage/v1${signed}`;
}
