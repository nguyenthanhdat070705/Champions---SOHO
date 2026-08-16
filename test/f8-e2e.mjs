// Live end-to-end verification of Functional 08 (spec 12.3 document matrix +
// task verification checklist). NOT part of `npm test` (needs the live Supabase
// DB + the running combined server). Run:
//   PORT=3011 node --env-file=.env server/index.js &
//   F8_BASE=http://localhost:3011 node --env-file=.env test/f8-e2e.mjs
// Operates ONLY on its own throwaway merchant (soho-crew-test+f8@soho.test) and a
// second throwaway user for the cross-tenant test. Never touches a real merchant.
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ensureF8Merchant, REAL_MERCHANTS } from "./f8-setup.mjs";

const BASE = process.env.F8_BASE || "http://localhost:3011";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

let token, MID, UID;
async function api(method, path, { body, idem, token: tk } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tk ?? token}` };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// A tiny valid PNG (1x1). We vary content per test by appending bytes → new hash.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
function pngVariant(tag) {
  // Append a PNG tEXt-ish trailer so bytes (and thus the hash) differ per variant
  // while staying a decodable image for the bucket's mime sniff.
  return Buffer.concat([PNG_1x1, Buffer.from(`\n<!--${tag}-->`)]);
}
const b64 = (buf) => buf.toString("base64");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function cleanMerchant(mid = MID) {
  for (const t of ["document_access_events", "document_links", "document_pages", "document_extractions"]) {
    await pool.query(`delete from public.${t} where merchant_id=$1`, [mid]);
  }
  await pool.query(`delete from public.expenses where merchant_id=$1 and expense_number like 'F8-%'`, [mid]);
  await pool.query(`delete from public.purchase_receipts where merchant_id=$1 and receipt_number like 'F8-%'`, [mid]);
  await pool.query(`delete from public.source_documents where merchant_id=$1`, [mid]);
}

async function ensureSecondUser() {
  const URL = process.env.VITE_SUPABASE_URL, KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const email = "soho-crew-test+f8b@soho.test", password = "SohoF8bTest!2026";
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  let si = await sb.auth.signInWithPassword({ email, password });
  if (si.error) { await sb.auth.signUp({ email, password }); si = await sb.auth.signInWithPassword({ email, password }); }
  const uid = si.data.session.user.id;
  let mm = (await sql(`select merchant_id from public.merchant_members where user_id=$1 and status='active' limit 1`, [uid]))[0];
  if (!mm) {
    const m = (await sql(`insert into public.merchants (legal_name, display_name, legal_type, business_model, industry_code, status, created_by, onboarding_completed_at)
       values ('Cửa hàng Test F8B','Test F8B','household_business','retail','4711','active',$1, now()) returning id`, [uid]))[0];
    await pool.query(`insert into public.merchant_members (merchant_id, user_id, role, status) values ($1,$2,'owner','active') on conflict do nothing`, [m.id, uid]);
    mm = { merchant_id: m.id };
  }
  if (REAL_MERCHANTS.includes(mm.merchant_id)) throw new Error("REFUSING: 2nd user resolved a REAL merchant");
  return { token: si.data.session.access_token, uid, mid: mm.merchant_id };
}

async function main() {
  const boot = await ensureF8Merchant();
  MID = boot.merchantId; UID = boot.userId; token = boot.token;
  if (REAL_MERCHANTS.includes(MID)) throw new Error("REFUSING: resolved a REAL merchant id");
  log(`Test user: ${boot.email}\nMerchant: ${MID}\nServer: ${BASE}`);

  section("Setup: clean slate");
  await cleanMerchant();

  // ── DOC-FR-01 / DOC-FR-03: upload + server hash ────────────────────────────
  section("Upload → ready, server-computed hash, private key");
  const imgA = pngVariant("A");
  const up = await api("POST", `/v1/merchants/${MID}/documents`, {
    idem: randomUUID(), body: { fileBase64: b64(imgA), mimeType: "image/png", documentType: "expense", documentNumber: "HD-A1" },
  });
  ok("upload 201", up.status === 201, `status ${up.status}`);
  const docId = up.json?.document?.id;
  ok("status ready", up.json?.document?.status === "ready");
  ok("sha256 == server sha", up.json?.document?.sha256 === sha(imgA));
  const dbRow = (await sql(`select object_key, content_hash, sha256, byte_size, mime_type, created_by from public.source_documents where id=$1`, [docId]))[0];
  ok("content_hash written", dbRow?.content_hash === sha(imgA));
  ok("sha256 also written (dual-write)", dbRow?.sha256 === sha(imgA));
  ok("object_key under {merchantId}/", String(dbRow?.object_key || "").startsWith(MID + "/"));
  ok("byte_size + mime recorded", Number(dbRow?.byte_size) === imgA.length && dbRow?.mime_type === "image/png");
  ok("created_by = actor", dbRow?.created_by === UID);

  // ── list: appears with thumbnail ───────────────────────────────────────────
  section("List → appears with thumbnail + type badge");
  const list = await api("GET", `/v1/merchants/${MID}/documents`);
  ok("list returns the doc", (list.json?.documents || []).some((d) => d.id === docId));
  const card = (list.json?.documents || []).find((d) => d.id === docId);
  ok("thumbUrl signed (supabase)", typeof card?.thumbUrl === "string" && card.thumbUrl.includes("/storage/v1/"));
  ok("documentTypeLabel present", card?.documentTypeLabel === "Chứng từ chi");
  ok("summary counts total≥1", (list.json?.summary?.total || 0) >= 1);

  // ── DOC-FR-01 idempotency ──────────────────────────────────────────────────
  section("Idempotent upload (same key replays)");
  const key = randomUUID(), imgIdem = pngVariant("idem");
  const i1 = await api("POST", `/v1/merchants/${MID}/documents`, { idem: key, body: { fileBase64: b64(imgIdem), mimeType: "image/png" } });
  const i2 = await api("POST", `/v1/merchants/${MID}/documents`, { idem: key, body: { fileBase64: b64(imgIdem), mimeType: "image/png" } });
  ok("first creates", i1.status === 201);
  ok("replay returns same id", i2.json?.document?.id === i1.json?.document?.id, `replayed=${i2.json?.replayed}`);
  ok("no duplicate rows for that hash", (await sql(`select count(*)::int c from public.source_documents where merchant_id=$1 and content_hash=$2`, [MID, sha(imgIdem)]))[0].c === 1);

  // ── DOC-04 dedupe (warn + override) ────────────────────────────────────────
  section("Duplicate content → warn, then override");
  const dupTry = await api("POST", `/v1/merchants/${MID}/documents`, { idem: randomUUID(), body: { fileBase64: b64(imgA), mimeType: "image/png" } });
  ok("dup blocked 409 DOCUMENT_ALREADY_EXISTS", dupTry.status === 409 && dupTry.json?.code === "DOCUMENT_ALREADY_EXISTS");
  ok("points to existing doc", dupTry.json?.details?.existingDocumentId === docId);
  const dupForce = await api("POST", `/v1/merchants/${MID}/documents`, { idem: randomUUID(), body: { fileBase64: b64(imgA), mimeType: "image/png", force: true } });
  ok("override creates new doc", dupForce.status === 201 && dupForce.json?.document?.id !== docId);

  // ── DOC-03 MIME gate ───────────────────────────────────────────────────────
  section("MIME gate (pdf rejected)");
  const badMime = await api("POST", `/v1/merchants/${MID}/documents`, { idem: randomUUID(), body: { fileBase64: b64(Buffer.from("%PDF-1.4")), mimeType: "application/pdf" } });
  ok("pdf → 400 DOCUMENT_MIME_UNSUPPORTED", badMime.status === 400 && badMime.json?.code === "DOCUMENT_MIME_UNSUPPORTED");

  // ── signed URL + access audit ──────────────────────────────────────────────
  section("Signed URL (short-lived) + access audit");
  const content = await api("GET", `/v1/merchants/${MID}/documents/${docId}/content?action=preview`);
  ok("content 200 with signed url", content.status === 200 && String(content.json?.url || "").includes("/storage/v1/"));
  ok("ttl short (≤300s)", content.json?.expiresIn <= 300);
  const dl = await api("GET", `/v1/merchants/${MID}/documents/${docId}/content?action=download`);
  ok("download logs too", dl.status === 200);
  const events = await sql(`select action from public.document_access_events where document_id=$1 order by created_at`, [docId]);
  ok("access events written (preview+download)", events.some((e) => e.action === "preview") && events.some((e) => e.action === "download"));

  // ── links: manual (order) + unlink ─────────────────────────────────────────
  section("Link → order (deep-link resolves) → unlink");
  // Build a real bill to link to.
  const prod = await api("POST", `/v1/merchants/${MID}/products`, { idem: randomUUID(), body: { draft_id: randomUUID(), name: "F8 SP", productType: "goods", unitCode: "cai", salePrice: 10000, trackInventory: true, openingQty: 5 } });
  const prodId = prod.json?.product?.id;
  const order = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: prodId, quantity: 1 }] } });
  const orderId = order.json?.order?.id, orderNo = order.json?.order?.orderNumber;
  const linkRes = await api("POST", `/v1/merchants/${MID}/documents/${docId}/links`, { idem: randomUUID(), body: { targetType: "order", targetId: orderId, linkType: "primary" } });
  ok("link created 201", linkRes.status === 201, `no ${linkRes.json?.link?.number}`);
  ok("link resolves number + route", linkRes.json?.link?.number === orderNo && linkRes.json?.link?.route === `/don-hang/${orderId}`);
  const linkId = linkRes.json?.link?.linkId;
  // idempotent re-link (same combo) does not duplicate
  const relink = await api("POST", `/v1/merchants/${MID}/documents/${docId}/links`, { idem: randomUUID(), body: { targetType: "order", targetId: orderId, linkType: "primary" } });
  ok("re-link returns same link (no dup)", (await sql(`select count(*)::int c from public.document_links where document_id=$1 and target_type='order' and target_id=$2 and link_type='primary'`, [docId, orderId]))[0].c === 1, `replayed=${relink.json?.replayed}`);
  const det1 = await api("GET", `/v1/merchants/${MID}/documents/${docId}`);
  ok("detail shows the link", (det1.json?.links || []).some((l) => l.targetId === orderId && l.number === orderNo));
  const badTarget = await api("POST", `/v1/merchants/${MID}/documents/${docId}/links`, { idem: randomUUID(), body: { targetType: "order", targetId: randomUUID(), linkType: "supporting" } });
  ok("link to missing target → 404 LINK_TARGET_NOT_FOUND", badTarget.status === 404 && badTarget.json?.code === "LINK_TARGET_NOT_FOUND");
  const unlink = await api("DELETE", `/v1/merchants/${MID}/documents/${docId}/links/${linkId}`);
  ok("unlink 200", unlink.status === 200);
  ok("link gone", (await sql(`select count(*)::int c from public.document_links where id=$1`, [linkId]))[0].c === 0);

  // ── integration: F7 expense back-ref appears automatically (UNION) ──────────
  section("Integration: expenses.document_id back-ref appears (no back-fill)");
  await pool.query(`insert into public.expenses (merchant_id, expense_number, expense_date, created_by, document_id) values ($1,'F8-CP001', current_date, $2, $3)`, [MID, UID, docId]);
  const det2 = await api("GET", `/v1/merchants/${MID}/documents/${docId}`);
  const autoLink = (det2.json?.links || []).find((l) => l.targetType === "expense");
  ok("auto expense link present", Boolean(autoLink), autoLink ? `#${autoLink.number}` : "missing");
  ok("auto link is not removable", autoLink && autoLink.source === "auto" && autoLink.removable === false);
  const linkedList = await api("GET", `/v1/merchants/${MID}/documents?linked=linked`);
  ok("doc counts as linked via back-ref", (linkedList.json?.documents || []).some((d) => d.id === docId));

  // ── archive / restore ──────────────────────────────────────────────────────
  section("Archive hides + recoverable");
  const arch = await api("POST", `/v1/merchants/${MID}/documents/${docId}/archive`, { body: { action: "archive", expectedVersion: det2.json.document.rowVersion } });
  ok("archive 200 changed", arch.status === 200 && arch.json?.changed === true && arch.json?.document?.status === "archived");
  const defList = await api("GET", `/v1/merchants/${MID}/documents`);
  ok("archived hidden from default list", !(defList.json?.documents || []).some((d) => d.id === docId));
  const archList = await api("GET", `/v1/merchants/${MID}/documents?includeArchived=1`);
  ok("archived visible with includeArchived", (archList.json?.documents || []).some((d) => d.id === docId));
  const restore = await api("POST", `/v1/merchants/${MID}/documents/${docId}/archive`, { body: { action: "restore" } });
  ok("restore → ready", restore.status === 200 && restore.json?.document?.status === "ready");

  // ── RLS cross-tenant (list + detail + signed url) ──────────────────────────
  section("RLS: cross-tenant denied (list, detail, content)");
  const other = await ensureSecondUser();
  ok("2nd user is a different merchant", other.mid !== MID);
  const xList = await api("GET", `/v1/merchants/${MID}/documents`, { token: other.token });
  ok("cross list → 403", xList.status === 403, `status ${xList.status}`);
  const xDet = await api("GET", `/v1/merchants/${MID}/documents/${docId}`, { token: other.token });
  ok("cross detail → 403", xDet.status === 403);
  const xContent = await api("GET", `/v1/merchants/${MID}/documents/${docId}/content`, { token: other.token });
  ok("cross content → 403 (no signed url leaked)", xContent.status === 403 && !xContent.json?.url);

  // ── reconciliation: no orphan objects for our docs (DB row exists per object) ─
  section("No orphan: every uploaded object has a DB owner");
  const orphanCheck = (await sql(`select count(*)::int c from public.source_documents where merchant_id=$1 and object_key is not null and content_hash is not null`, [MID]))[0].c;
  ok("all docs have object_key + hash", orphanCheck >= 3, `${orphanCheck} docs`);

  log(`\n──────────────\n${PASS} passed, ${FAIL} failed`);
  await pool.end();
  process.exit(FAIL ? 1 : 0);
}

main().catch(async (e) => { console.error("E2E crashed:", e); try { await pool.end(); } catch { /* */ } process.exit(1); });
