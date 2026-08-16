// Functional 06 — source documents: upload, duplicate detection, AI extraction
// and product matching (spec 3.5 / 3.6 / 4.3 / 11). A document is EVIDENCE, not a
// posting: uploading never changes stock. The flow is:
//   1. hash the bytes → look for an existing document with the same content hash
//      (or a receipt with a matching document_number). If found, WARN with the
//      candidate receipt(s) and do NOT re-import (REC-06 / spec 2.2) unless the
//      caller explicitly overrides (owner/manager, spec 12.1).
//   2. upload the bytes to the private bucket and record source_documents.
//   3. (optional) run Gemini extraction → document_extractions row + a draft the
//      review screen consumes. Extraction failure keeps the document (REC-FR-12).
import { query, getPool } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { normalizeSearchName } from "../f3/text.js";
import { contentHash, perceptualHash, duplicateLevel } from "./receiving-math.js";
import { decodeImage, objectKeyFor, uploadDocument, downloadDocument, signDocumentUrl } from "./storage.js";
import { extractReceiptFromImage } from "./gemini.js";

const EXTRACTOR_VERSION = "gemini-flash-latest-r1";

/** Find receipts already linked to a document (dedupe candidates for the UI). */
async function receiptsForDocument(merchantId, documentId) {
  const { rows } = await query(
    `select id, receipt_number, status, grand_total_vnd
       from public.purchase_receipts
      where merchant_id=$1 and document_id=$2
      order by created_at desc`,
    [merchantId, documentId],
  );
  return rows.map((r) => ({
    receiptId: r.id, receiptNumber: r.receipt_number, status: r.status, totalVnd: Number(r.grand_total_vnd),
  }));
}

/** Candidate receipts matching a document_number (a softer duplicate signal). */
async function receiptsForDocumentNumber(merchantId, documentNumber) {
  if (!documentNumber) return [];
  const { rows } = await query(
    `select pr.id, pr.receipt_number, pr.status, pr.grand_total_vnd
       from public.purchase_receipts pr
       join public.source_documents sd on sd.id = pr.document_id
      where pr.merchant_id=$1 and sd.document_number is not null
        and lower(sd.document_number)=lower($2)
      order by pr.created_at desc limit 5`,
    [merchantId, documentNumber],
  );
  return rows.map((r) => ({
    receiptId: r.id, receiptNumber: r.receipt_number, status: r.status, totalVnd: Number(r.grand_total_vnd),
  }));
}

/**
 * POST /receiving/documents — upload a document, detect duplicates, and (when
 * `extract` is set) run AI extraction. Returns the document + optional draft, or
 * a duplicate warning with candidate receipts.
 * @param {string} token caller JWT (for the merchant-scoped storage policy)
 */
export async function createDocument(merchantId, userId, token, input = {}) {
  const { image, mimeType, documentNumber, force } = input;
  const { buf, mime, ext } = decodeImage(image, mimeType);
  const hash = contentHash(buf);
  const phash = perceptualHash(buf);
  const docNumber = documentNumber ? String(documentNumber).trim().slice(0, 60) || null : null;

  // 1) Duplicate detection (spec 4.3). Exact content hash is the strong signal.
  if (!force) {
    const { rows: existing } = await query(
      `select id, document_number from public.source_documents
         where merchant_id=$1 and content_hash=$2 order by captured_at desc limit 1`,
      [merchantId, hash],
    );
    let candidates = [];
    if (existing.length) {
      candidates = await receiptsForDocument(merchantId, existing[0].id);
    }
    const byNumber = await receiptsForDocumentNumber(merchantId, docNumber);
    for (const c of byNumber) if (!candidates.some((x) => x.receiptId === c.receiptId)) candidates.push(c);

    if (existing.length || candidates.length) {
      throw new DomainError("POSSIBLE_DUPLICATE_DOCUMENT", undefined, {
        action: "REVIEW_DUPLICATE_CANDIDATES",
        existingDocumentId: existing[0]?.id ?? null,
        candidates,
      });
    }
  }

  // 2) Persist the document row first so we own its id → object key.
  const { rows: ins } = await query(
    `insert into public.source_documents (merchant_id, object_key, content_hash, perceptual_hash, document_number)
     values ($1,$2,$3,$4,$5) returning id, captured_at`,
    [merchantId, "pending", hash, phash, docNumber],
  );
  const documentId = ins[0].id;
  const objectKey = objectKeyFor(merchantId, documentId, ext);

  // 3) Upload the bytes, then finalise the object key.
  await uploadDocument(token, objectKey, buf, mime);
  await query(`update public.source_documents set object_key=$1 where id=$2`, [objectKey, documentId]);

  const result = {
    documentId, objectKey, contentHash: hash, documentNumber: docNumber, capturedAt: ins[0].captured_at,
  };

  if (input.extract) {
    result.extraction = await runExtraction(merchantId, documentId, buf, mime);
  }
  return result;
}

/**
 * Run + persist an extraction for a document's bytes; match lines to products.
 * On provider failure this returns a `status:'failed'` marker instead of throwing
 * so the caller keeps the document and falls back to manual entry (REC-FR-12 /
 * REC-07). The 'failed' extraction row is recorded for AI-quality evaluation.
 */
async function runExtraction(merchantId, documentId, buf, mime) {
  const base64 = buf.toString("base64");
  let draft;
  try {
    draft = await extractReceiptFromImage(base64, mime);
  } catch (err) {
    const errorCode = err instanceof DomainError ? err.code : "AI_EXTRACT_FAILED";
    await query(
      `insert into public.document_extractions (merchant_id, document_id, extractor_version, status, error_code)
       values ($1,$2,$3,'failed',$4)
       on conflict (document_id, extractor_version)
       do update set status='failed', error_code=excluded.error_code`,
      [merchantId, documentId, EXTRACTOR_VERSION, errorCode],
    );
    return {
      documentId, status: "failed", errorCode,
      supplier: null, receivedDate: null, documentNumber: null, lines: [], totalHintVnd: null,
      fieldConfidence: { supplier: null, receivedDate: null, documentNumber: null },
      warnings: ["Chưa đọc được chứng từ. Bạn có thể nhập tay, ảnh vẫn được lưu."],
    };
  }

  const matched = await matchLines(merchantId, draft.lines);
  const payload = { ...draft, lines: matched };
  const fieldConfidence = draft.fieldConfidence;
  await query(
    `insert into public.document_extractions (merchant_id, document_id, extractor_version, status, payload, field_confidence)
     values ($1,$2,$3,'done',$4,$5)
     on conflict (document_id, extractor_version)
     do update set status='done', payload=excluded.payload, field_confidence=excluded.field_confidence, error_code=null`,
    [merchantId, documentId, EXTRACTOR_VERSION, JSON.stringify(payload), JSON.stringify(fieldConfidence)],
  );
  return { documentId, status: "done", ...payload };
}

/**
 * Suggest a catalog product for each extracted line (spec 3.6 / 4.3). Exact SKU/
 * barcode beats fuzzy name; a fuzzy name match only proposes a candidate — it is
 * never auto-confirmed (the review screen forces the user to accept/assign).
 */
async function matchLines(merchantId, lines) {
  const out = [];
  for (const line of lines || []) {
    const match = await matchOneLine(merchantId, line.description);
    out.push({ ...line, match });
  }
  return out;
}

async function matchOneLine(merchantId, description) {
  const norm = normalizeSearchName(description);
  if (!norm) return { productId: null, name: null, source: "none", confidence: 0, candidates: [] };
  // Prefix + contains search over the unaccented search_name; also try exact SKU.
  const { rows } = await query(
    `select id, name, sku, unit_code, search_name
       from public.products
      where merchant_id=$1 and product_type='goods' and status <> 'archived'
        and (search_name like $2 or search_name like $3 or upper(coalesce(sku,''))=upper($4))
      order by (search_name = $5) desc, length(name) asc
      limit 5`,
    [merchantId, `%${norm}%`, `${norm}%`, description.trim(), norm],
  );
  const candidates = rows.map((r) => ({ productId: r.id, name: r.name, sku: r.sku, unitCode: r.unit_code }));
  if (candidates.length === 0) return { productId: null, name: null, source: "none", confidence: 0, candidates: [] };
  const best = rows[0];
  const exact = best.search_name === norm;
  return {
    productId: exact ? best.id : null, // only auto-fill on an exact normalized name
    name: best.name,
    source: exact ? "ai" : "candidate",
    confidence: exact ? 0.9 : 0.5,
    candidates,
  };
}

/** POST /receiving/documents/:id/extract — (re)run extraction from stored bytes. */
export async function extractDocument(merchantId, userId, token, documentId) {
  const { rows } = await query(
    `select id, object_key from public.source_documents where id=$1 and merchant_id=$2`,
    [documentId, merchantId],
  );
  if (rows.length === 0) fail("DOCUMENT_NOT_FOUND");
  const objectKey = rows[0].object_key;
  const buf = await downloadDocument(token, objectKey);
  const mime = objectKey.endsWith(".png") ? "image/png" : objectKey.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return runExtraction(merchantId, documentId, buf, mime);
}

/** GET /receiving/documents/:id/url — a short-lived signed URL (REC-FR-11). */
export async function getDocumentUrl(merchantId, token, documentId) {
  const { rows } = await query(
    `select object_key from public.source_documents where id=$1 and merchant_id=$2`,
    [documentId, merchantId],
  );
  if (rows.length === 0) fail("DOCUMENT_NOT_FOUND");
  const url = await signDocumentUrl(token, rows[0].object_key, 300);
  return { url, expiresIn: 300 };
}
