// Functional 08 — "Hộp chứng từ" document service (spec 1 / 3 / 4 / 7 / 10).
// A document is EVIDENCE, not a business record: the source object is immutable
// and private, dedupe is by server-computed hash, links are semantic relations
// and AI never links/posts. All mutations run through the pooler (bypasses RLS)
// AFTER the router has verified the caller's JWT + merchant membership — that Node
// check IS the tenant boundary (NFR-04 / DOC-11), mirroring F3/F5. Storage access
// uses the caller's OWN JWT so Storage RLS still applies (see storage.js).
import { createHash, randomUUID } from "node:crypto";
import { query, withTransaction, getPool } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { writeAudit } from "../f3/audit.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import {
  MAX_BYTES, DOCUMENT_TYPE_LABELS, TARGET_TYPES, VIEWABLE_STATUSES,
  requireAllowedMime, requireAllowedSize, normalizeDocumentType,
  requireLinkType, requireTargetType, targetRoute, extForMime,
} from "./types.js";
import { uploadObject, removeObject, signOne, signMany } from "./storage.js";

// ── Shared row mappers ───────────────────────────────────────────────────────
function mapDoc(r) {
  return {
    id: r.id,
    status: r.status,
    documentType: r.document_type,
    documentTypeLabel: r.document_type ? (DOCUMENT_TYPE_LABELS[r.document_type] || "Khác") : null,
    documentNumber: r.document_number,
    mimeType: r.mime_type,
    byteSize: r.byte_size == null ? null : Number(r.byte_size),
    sha256: r.sha256 || r.content_hash || null,
    capturedAt: r.captured_at,
    finalizedAt: r.finalized_at,
    retainUntil: r.retain_until,
    legalHold: Boolean(r.legal_hold),
    retentionStatus: r.retention_status,
    rowVersion: Number(r.row_version ?? 1),
    createdBy: r.created_by,
  };
}

/**
 * Resolve every document's links for a set of doc ids (spec 3.5 / 6 integration).
 * Two sources are UNIONed at read time — the SIMPLER correct integration than a
 * back-fill migration (task note): F8's own `document_links` rows AND the
 * back-references sibling lanes write on their records (`expenses.document_id`,
 * `purchase_receipts.document_id`). Auto back-refs are 'primary' and NOT removable
 * from here (that would edit the owning record). Returns Map<docId, LinkView[]>.
 */
async function resolveLinks(merchantId, docIds) {
  const out = new Map();
  if (docIds.length === 0) return out;
  const { rows } = await query(
    `select document_id, id::text as link_id, target_type, target_id, link_type,
            'manual' as source, created_at
       from public.document_links
      where merchant_id = $1 and document_id = any($2)
     union all
     select document_id, null as link_id, 'expense' as target_type, id as target_id,
            'primary' as link_type, 'auto' as source, created_at
       from public.expenses
      where merchant_id = $1 and document_id = any($2)
     union all
     select document_id, null as link_id, 'purchase_receipt' as target_type, id as target_id,
            'primary' as link_type, 'auto' as source, created_at
       from public.purchase_receipts
      where merchant_id = $1 and document_id = any($2)`,
    [merchantId, docIds],
  );

  // Dedup by (document_id, target_type, target_id): a manual link wins over an auto back-ref.
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.document_id}|${r.target_type}|${r.target_id}`;
    const prev = byKey.get(k);
    if (!prev || (prev.source === "auto" && r.source === "manual")) byKey.set(k, r);
  }

  // Batch-resolve the human number per target_type (allowlisted tables only).
  const byType = new Map();
  for (const r of byKey.values()) {
    if (!byType.has(r.target_type)) byType.set(r.target_type, new Set());
    byType.get(r.target_type).add(r.target_id);
  }
  const numbers = new Map(); // `${type}|${id}` -> number
  for (const [type, ids] of byType) {
    const spec = TARGET_TYPES[type];
    if (!spec) continue;
    const { rows: tr } = await query(
      `select id, ${spec.numberCol} as number from public.${spec.table}
        where merchant_id = $1 and id = any($2)`,
      [merchantId, [...ids]],
    );
    for (const t of tr) numbers.set(`${type}|${t.id}`, t.number);
  }

  for (const r of byKey.values()) {
    const spec = TARGET_TYPES[r.target_type];
    const number = numbers.get(`${r.target_type}|${r.target_id}`) ?? null;
    const view = {
      linkId: r.link_id,
      targetType: r.target_type,
      targetId: r.target_id,
      targetLabel: spec ? spec.label : r.target_type,
      linkType: r.link_type,
      number,
      route: number != null ? targetRoute(r.target_type, r.target_id) : null,
      source: r.source, // 'manual' | 'auto'
      removable: r.source === "manual",
      // A dangling target (number null) means the record was deleted/changed.
      missing: number == null,
      createdAt: r.created_at,
    };
    const arr = out.get(r.document_id) || [];
    arr.push(view);
    out.set(r.document_id, arr);
  }
  return out;
}

// ── List (spec 3.1 / 10 GET /documents) ──────────────────────────────────────
/**
 * Inbox / search over the merchant's documents. Filters: type, linked/unlinked,
 * month (captured_at, Asia/Ho_Chi_Minh), and a text search over document_number.
 * Archived docs are hidden unless includeArchived=1 (spec 3.8). Thumbnails are
 * batch-signed in ONE storage call and are NOT audited (previews, not "opens").
 */
export async function listDocuments(merchantId, token, {
  search, type, linked, month, includeArchived, limit, offset,
} = {}) {
  const params = [merchantId];
  const where = ["d.merchant_id = $1", "d.status <> 'purged'"];
  if (!includeArchived) where.push("d.status <> 'archived'");
  if (type) { params.push(type); where.push(`d.document_type = $${params.length}`); }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    where.push(`lower(coalesce(d.document_number,'')) like $${params.length}`);
  }
  if (month && /^\d{4}-\d{2}$/.test(String(month))) {
    params.push(`${month}-01`);
    where.push(`(d.captured_at at time zone 'Asia/Ho_Chi_Minh') >= $${params.length}::date
                and (d.captured_at at time zone 'Asia/Ho_Chi_Minh') < ($${params.length}::date + interval '1 month')`);
  }

  // linked/unlinked is computed against BOTH link sources (spec 6 integration).
  const linkedExpr = `(exists (select 1 from public.document_links dl where dl.document_id = d.id)
     or exists (select 1 from public.expenses e where e.document_id = d.id)
     or exists (select 1 from public.purchase_receipts pr where pr.document_id = d.id))`;
  if (linked === "linked") where.push(linkedExpr);
  else if (linked === "unlinked") where.push(`not ${linkedExpr}`);

  const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  const off = Math.max(0, Number(offset) || 0);
  params.push(lim + 1); const iLim = params.length;
  params.push(off); const iOff = params.length;

  const { rows } = await query(
    `select d.*, ${linkedExpr} as is_linked
       from public.source_documents d
      where ${where.join(" and ")}
      order by d.captured_at desc, d.id desc
      limit $${iLim} offset $${iOff}`,
    params,
  );
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim);

  // Summary chip counts (unpaginated, respects month/type/search but not linked filter).
  const sumParams = [merchantId];
  const sumWhere = ["d.merchant_id = $1", "d.status <> 'purged'", "d.status <> 'archived'"];
  const { rows: sum } = await query(
    `select count(*)::int as total,
            count(*) filter (where ${linkedExpr})::int as linked,
            count(*) filter (where not ${linkedExpr})::int as unlinked
       from public.source_documents d where ${sumWhere.join(" and ")}`,
    sumParams,
  );

  // Links (representative) + thumbnails for the page.
  const ids = page.map((r) => r.id);
  const links = await resolveLinks(merchantId, ids);
  const thumbs = await signMany(token, page.filter((r) => r.status !== "quarantined").map((r) => r.object_key));

  const documents = page.map((r) => {
    const docLinks = links.get(r.id) || [];
    return {
      ...mapDoc(r),
      linked: Boolean(r.is_linked),
      linkCount: docLinks.length,
      primaryLink: docLinks[0] || null,
      thumbUrl: r.status === "quarantined" ? null : (thumbs.get(r.object_key) || null),
    };
  });

  return {
    documents,
    hasMore,
    nextOffset: hasMore ? off + lim : null,
    summary: sum[0] || { total: 0, linked: 0, unlinked: 0 },
  };
}

// ── Detail (spec 3.5 / 10 GET /documents/:id) ────────────────────────────────
export async function getDocumentDetail(merchantId, documentId) {
  const { rows } = await query(
    `select * from public.source_documents where id = $1 and merchant_id = $2`,
    [documentId, merchantId],
  );
  if (rows.length === 0) fail("DOCUMENT_NOT_FOUND");
  const r = rows[0];

  const links = (await resolveLinks(merchantId, [documentId])).get(documentId) || [];

  const { rows: pages } = await query(
    `select page_no, width, height, derivative_key from public.document_pages
      where document_id = $1 order by page_no`, [documentId]);

  const { rows: access } = await query(
    `select a.action, a.purpose, a.created_at, p.full_name as actor_name
       from public.document_access_events a
       left join public.profiles p on p.user_id = a.actor_id
      where a.document_id = $1
      order by a.created_at desc limit 30`, [documentId]);

  return {
    document: mapDoc(r),
    links,
    pages: pages.map((p) => ({ pageNo: p.page_no, width: p.width, height: p.height })),
    access: access.map((a) => ({
      action: a.action, purpose: a.purpose, createdAt: a.created_at, actorName: a.actor_name || null,
    })),
  };
}

// ── Content / signed URL (spec 3.5 / 9.4 / 10 GET /documents/:id/content) ─────
/**
 * Membership+status+purpose check → write access audit → return a short-lived
 * signed URL. Quarantined/purged docs never get a URL (DOC-04 / DOC-10). The
 * access event is the ONLY place a view/download is recorded; the signed URL is
 * never logged (spec 12.2).
 */
export async function getContent(merchantId, userId, token, documentId, action = "preview") {
  const act = action === "download" ? "download" : "preview";
  const { rows } = await query(
    `select id, status, object_key from public.source_documents where id = $1 and merchant_id = $2`,
    [documentId, merchantId],
  );
  if (rows.length === 0) fail("DOCUMENT_NOT_FOUND");
  const d = rows[0];
  if (d.status === "quarantined") fail("DOCUMENT_QUARANTINED");
  if (d.status === "purged") fail("DOCUMENT_NOT_FOUND");
  if (!VIEWABLE_STATUSES.includes(d.status)) fail("DOCUMENT_NOT_VIEWABLE");

  await query(
    `insert into public.document_access_events (merchant_id, document_id, actor_id, action, purpose)
     values ($1,$2,$3,$4,$5)`,
    [merchantId, documentId, userId, act, act === "download" ? "download_original" : "view_preview"],
  );

  const url = await signOne(token, d.object_key);
  return { url, action: act, expiresIn: 120 };
}

// ── Upload (spec 3.2/3.3 / 10 POST /documents) ───────────────────────────────
/**
 * Standalone upload. Server computes the authoritative SHA-256 (spec 4.2 — never
 * trust a client hash), dedupes within the merchant (DOC-03/DOC-06: a same-bytes
 * upload returns the existing doc unless `force`), uploads to private storage
 * under the caller's JWT, then records the row. On a DB failure the just-uploaded
 * object is removed so no orphan survives (DOC-05, best-effort). Idempotent per key.
 */
export async function uploadDocument(merchantId, userId, token, input, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const mime = requireAllowedMime(input.mimeType);
  const base64 = String(input.fileBase64 || "").replace(/^data:[^;]+;base64,/, "");
  let buffer;
  try { buffer = Buffer.from(base64, "base64"); } catch { buffer = Buffer.alloc(0); }
  const byteSize = requireAllowedSize(buffer.length);
  if (byteSize > MAX_BYTES) fail("DOCUMENT_TOO_LARGE");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const documentType = normalizeDocumentType(input.documentType);
  const documentNumber = input.documentNumber ? String(input.documentNumber).trim().slice(0, 120) : null;
  const force = input.force === true || input.force === "true";

  const canonical = { sha256, byteSize, mime, force, documentType };
  const { result, replayed } = await runIdempotent("doc-upload", idemKey, bodyHash(canonical), async () => {
    // Dedupe by server hash within the merchant (spec 4.2).
    const dup = await query(
      `select id, status, document_type, mime_type, byte_size, captured_at, document_number
         from public.source_documents
        where merchant_id = $1 and content_hash = $2 and status <> 'purged'
        order by captured_at desc limit 1`,
      [merchantId, sha256],
    );
    if (dup.rows.length > 0 && !force) {
      const ex = dup.rows[0];
      throw new DomainError("DOCUMENT_ALREADY_EXISTS", undefined, {
        action: "OPEN_EXISTING_DOCUMENT",
        existingDocumentId: ex.id,
        document: mapDoc(ex),
      });
    }

    const ext = extForMime(mime);
    const objectKey = `${merchantId}/${randomUUID()}.${ext}`;
    await uploadObject(token, objectKey, buffer, mime);

    try {
      return await withTransaction(async (client) => {
        const ins = await client.query(
          `insert into public.source_documents
             (merchant_id, object_key, content_hash, sha256, mime_type, byte_size,
              document_type, document_number, status, retention_status, created_by, finalized_at)
           values ($1,$2,$3,$3,$4,$5,$6,$7,'ready','active',$8, now())
           returning *`,
          [merchantId, objectKey, sha256, mime, byteSize, documentType, documentNumber, userId],
        );
        const row = ins.rows[0];
        await writeAudit(client, {
          merchantId, actorUserId: userId, action: "document.finalized",
          entityType: "document", entityId: row.id,
          after: { objectKeyPrefix: merchantId, sha256, byteSize, mime, documentType, replacedDuplicate: force && dup.rows.length > 0 },
        });
        return { document: mapDoc(row), duplicateOverridden: force && dup.rows.length > 0 };
      });
    } catch (err) {
      await removeObject(token, objectKey); // avoid an orphan object (DOC-05)
      throw err;
    }
  });
  return { ...result, replayed };
}

// ── Links (spec 3.7 / 10 POST|DELETE /documents/:id/links) ───────────────────
export async function addLink(merchantId, userId, documentId, input, idemKey) {
  const targetType = requireTargetType(input.targetType);
  const linkType = requireLinkType(input.linkType || "supporting");
  const targetId = String(input.targetId || "").trim();
  if (!targetId) fail("VALIDATION", "Thiếu bản ghi đích.");

  const run = async () => withTransaction(async (client) => {
    const doc = await client.query(
      `select id, status from public.source_documents where id = $1 and merchant_id = $2`,
      [documentId, merchantId]);
    if (doc.rows.length === 0) fail("DOCUMENT_NOT_FOUND");
    if (["quarantined", "purged"].includes(doc.rows[0].status)) fail("DOCUMENT_NOT_VIEWABLE");

    const spec = TARGET_TYPES[targetType];
    const tgt = await client.query(
      `select id, ${spec.numberCol} as number from public.${spec.table}
        where id = $1 and merchant_id = $2`, [targetId, merchantId]);
    if (tgt.rows.length === 0) fail("LINK_TARGET_NOT_FOUND");

    const ins = await client.query(
      `insert into public.document_links (merchant_id, document_id, target_type, target_id, link_type, created_by)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (document_id, target_type, target_id, link_type) do nothing
       returning id`,
      [merchantId, documentId, targetType, targetId, linkType, userId]);

    let linkId, replayed;
    if (ins.rows.length === 0) {
      const ex = await client.query(
        `select id from public.document_links
          where document_id=$1 and target_type=$2 and target_id=$3 and link_type=$4`,
        [documentId, targetType, targetId, linkType]);
      linkId = ex.rows[0].id; replayed = true;
    } else {
      linkId = ins.rows[0].id; replayed = false;
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "document.linked",
        entityType: "document", entityId: documentId,
        after: { targetType, targetId, linkType, number: tgt.rows[0].number },
      });
      await client.query(
        `insert into public.document_access_events (merchant_id, document_id, actor_id, action, purpose)
         values ($1,$2,$3,'link',$4)`,
        [merchantId, documentId, userId, `${targetType}:${linkType}`]);
    }
    return {
      link: {
        linkId, targetType, targetId, linkType, number: tgt.rows[0].number,
        targetLabel: spec.label, route: targetRoute(targetType, targetId),
        source: "manual", removable: true, missing: false,
      },
      replayed,
    };
  });

  if (!idemKey) return run();
  const { result, replayed } = await runIdempotent(
    "doc-link", idemKey, bodyHash({ documentId, targetType, targetId, linkType }), run);
  return { ...result, replayed: result.replayed || replayed };
}

export async function removeLink(merchantId, userId, documentId, linkId) {
  return withTransaction(async (client) => {
    const del = await client.query(
      `delete from public.document_links
        where id = $1 and document_id = $2 and merchant_id = $3
        returning target_type, target_id, link_type`,
      [linkId, documentId, merchantId]);
    if (del.rows.length === 0) fail("LINK_NOT_FOUND");
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "document.unlinked",
      entityType: "document", entityId: documentId, before: del.rows[0],
    });
    return { removed: true, linkId };
  });
}

// ── Link candidates (spec 3.7 GET /documents/:id/link-candidates) ────────────
/** Recent records of a target type for the manual "Tìm thủ công" picker. */
export async function listLinkCandidates(merchantId, targetType, search) {
  const type = requireTargetType(targetType);
  const spec = TARGET_TYPES[type];
  const params = [merchantId];
  let filter = "";
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    filter = `and lower(coalesce(${spec.numberCol},'')) like $${params.length}`;
  }
  const { rows } = await query(
    `select id, ${spec.numberCol} as number, created_at
       from public.${spec.table}
      where merchant_id = $1 ${filter}
      order by created_at desc limit 20`, params);
  return {
    targetType: type, targetLabel: spec.label,
    candidates: rows.map((r) => ({
      targetId: r.id, number: r.number, createdAt: r.created_at,
      route: targetRoute(type, r.id),
    })),
  };
}

// ── Lifecycle: archive / restore (spec 3.8 / 4.3) ────────────────────────────
export async function setArchiveState(merchantId, userId, documentId, action, expectedVersion) {
  const restore = action === "restore";
  return withTransaction(async (client) => {
    const cur = await client.query(
      `select id, status, row_version, legal_hold from public.source_documents
        where id = $1 and merchant_id = $2 for update`, [documentId, merchantId]);
    if (cur.rows.length === 0) fail("DOCUMENT_NOT_FOUND");
    const d = cur.rows[0];
    if (d.status === "purged") fail("DOCUMENT_NOT_FOUND");
    if (expectedVersion != null && Number(d.row_version) !== Number(expectedVersion)) {
      throw new DomainError("DOCUMENT_VERSION_CHANGED", undefined, { currentVersion: Number(d.row_version) });
    }
    const nextStatus = restore ? "ready" : "archived";
    if (d.status === nextStatus) {
      return { document: mapDoc(d), changed: false };
    }
    if (restore && d.status !== "archived") fail("DOCUMENT_NOT_VIEWABLE");
    const upd = await client.query(
      `update public.source_documents set status = $1, row_version = row_version + 1
        where id = $2 and merchant_id = $3 returning *`,
      [nextStatus, documentId, merchantId]);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: `document.${restore ? "restored" : "archived"}`,
      entityType: "document", entityId: documentId,
      before: { status: d.status }, after: { status: nextStatus },
    });
    return { document: mapDoc(upd.rows[0]), changed: true };
  });
}

export { getPool };
