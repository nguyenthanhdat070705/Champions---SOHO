// Functional 14 LIVE end-to-end (spec §12.3 P0 matrix). Needs the combined server
// running with .env on a non-3000 PORT, then:
//   PORT=3014 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &
//   F14_BASE=http://localhost:3014 node --env-file=.env test/f14-e2e.mjs
// Runs on soho-crew-test+f14@soho.test (+f14b for RLS) — NEVER a real merchant.
// Not in `npm test` (`.mjs`, needs DB).
import { ensureF14, makePool, cleanClosingDay, cleanMoneyDay, seedCashDay } from "./f14-setup.mjs";

const BASE = process.env.F14_BASE || "http://localhost:3014";
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}${extra ? " — " + JSON.stringify(extra) : ""}`); } }

async function req(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json };
}
const uuid = () => crypto.randomUUID();

async function main() {
  const t = await ensureF14();
  const { merchantId, merchantIdB, userId, token, tokenB } = t;
  const M = (p) => `/v1/merchants/${merchantId}${p}`;
  const pool = makePool();

  const D_BAL = "2020-02-14", D_SHORT = "2020-02-13", D_DENOM = "2020-02-12", D_STALE = "2020-02-11";
  for (const d of [D_BAL, D_SHORT, D_DENOM, D_STALE]) {
    await cleanClosingDay(pool, merchantId, d);
    await cleanMoneyDay(pool, merchantId, d);
  }

  try {
    // ── CLS-03 + CLS-02(QR excluded): expected = Σ cash in − Σ cash out ──────
    // 3 cash bills (100k+200k+120k) − 1 cash refund (20k) = 400.000; +1 QR bill 500k (excluded)
    await seedCashDay(pool, merchantId, userId, D_BAL, { bills: [100000, 200000, 120000], refunds: [20000], qr: [500000], tag: "bal" });
    let r = await req("POST", M("/closings/prepare"), { token, body: { businessDate: D_BAL } });
    ok("prepare returns a draft (201)", r.status === 201 && r.json?.draft?.id, r.json);
    const balDraft = r.json.draft.id;
    ok("expected cash = 400.000 (cash only)", r.json.expected.expectedCashVnd === 400000, r.json.expected);
    ok("3 cash bills + 1 refund counted", r.json.expected.cashBillCount === 3 && r.json.expected.cashRefundCount === 1, r.json.expected);
    ok("QR bill NOT in the drawer (4 sources, no qr)", r.json.sources.length === 4 && !r.json.sources.some((s) => s.amountVnd === 500000), r.json.sources.map((s) => s.amountVnd));

    // ── CLS-04-ish + balanced confirm: count total = 400.000 → variance 0 ────
    r = await req("POST", M(`/closing-drafts/${balDraft}/counts`), { token, body: { clientCountId: uuid(), mode: "total", countedTotalVnd: 400000 } });
    ok("count saved, server variance 0", r.status === 201 && r.json.countedCashVnd === 400000 && r.json.variance === 0, r.json);
    r = await req("POST", M(`/closing-drafts/${balDraft}/preview`), { token, body: {} });
    ok("preview: no reason required when balanced", r.status === 200 && r.json.reasonRequired === false && r.json.previewHash, r.json);
    const balPreview = r.json;
    // ── CLS-08 retry: double-tap confirm with the SAME key → ONE revision ────
    const balKey = uuid();
    r = await req("POST", M(`/closing-drafts/${balDraft}/confirm`), { token, idem: balKey, body: { previewHash: balPreview.previewHash, countVersion: balPreview.countVersion, responsibilityConfirmed: true } });
    ok("confirm creates revision 1 (201, variance 0)", r.status === 201 && r.json.revisionNo === 1 && r.json.varianceVnd === 0, r.json);
    const balRev1 = r.json.revisionId;
    let r2 = await req("POST", M(`/closing-drafts/${balDraft}/confirm`), { token, idem: balKey, body: { previewHash: balPreview.previewHash, countVersion: balPreview.countVersion, responsibilityConfirmed: true } });
    ok("double-tap replays SAME revision (idempotent)", r2.json.revisionId === balRev1 && r2.json.replayed === true, r2.json);
    const revCount = (await pool.query(`select count(*)::int n from public.closing_revisions where closing_id=$1`, [balPreview.closingId])).rows[0].n;
    ok("exactly ONE revision row exists", revCount === 1, { revCount });

    // ── CLS-06: short count needs owner reason; confirm blocked without it ───
    await seedCashDay(pool, merchantId, userId, D_SHORT, { bills: [400000], tag: "sh" });
    r = await req("POST", M("/closings/prepare"), { token, body: { businessDate: D_SHORT } });
    const shDraft = r.json.draft.id;
    ok("short day expected 400.000", r.json.expected.expectedCashVnd === 400000, r.json.expected);
    r = await req("POST", M(`/closing-drafts/${shDraft}/counts`), { token, body: { clientCountId: uuid(), mode: "total", countedTotalVnd: 395000 } });
    ok("short count → variance −5.000", r.json.variance === -5000 && r.json.varianceClass === "shortage", r.json);
    r = await req("POST", M(`/closing-drafts/${shDraft}/preview`), { token, body: {} });
    ok("preview flags reason required", r.status === 200 && r.json.reasonRequired === true, r.json);
    // confirm WITHOUT reason → 422
    r = await req("POST", M(`/closing-drafts/${shDraft}/confirm`), { token, idem: uuid(), body: { previewHash: r.json.previewHash, countVersion: r.json.countVersion, responsibilityConfirmed: true } });
    ok("confirm blocked without reason (422)", r.status === 422 && r.json.code === "CLOSING_REASON_REQUIRED", r.json);
    // preview + confirm WITH reason
    r = await req("POST", M(`/closing-drafts/${shDraft}/preview`), { token, body: { reasonCode: "miscount" } });
    const shPrev = r.json;
    r = await req("POST", M(`/closing-drafts/${shDraft}/confirm`), { token, idem: uuid(), body: { previewHash: shPrev.previewHash, countVersion: shPrev.countVersion, reasonCode: "miscount", responsibilityConfirmed: true } });
    ok("confirm with reason → revision (variance −5.000)", r.status === 201 && r.json.varianceVnd === -5000, r.json);

    // ── CLS-04: denomination mode server-verified (client cannot fake total) ─
    await seedCashDay(pool, merchantId, userId, D_DENOM, { bills: [500000, 100000, 20000], tag: "dn" });
    r = await req("POST", M("/closings/prepare"), { token, body: { businessDate: D_DENOM } });
    const dnDraft = r.json.draft.id;
    ok("denom day expected 620.000", r.json.expected.expectedCashVnd === 620000, r.json.expected);
    r = await req("POST", M(`/closing-drafts/${dnDraft}/counts`), { token, body: { clientCountId: uuid(), mode: "denomination", countedTotalVnd: 999, denominations: [{ denominationVnd: 500000, quantity: 1 }, { denominationVnd: 100000, quantity: 1 }, { denominationVnd: 20000, quantity: 1 }] } });
    ok("denomination total computed server-side (=620.000, client 999 ignored)", r.json.countedCashVnd === 620000 && r.json.variance === 0, r.json);

    // ── CLS-07: source changes AFTER preview → confirm 409, no revision ──────
    await seedCashDay(pool, merchantId, userId, D_STALE, { bills: [300000], tag: "st" });
    r = await req("POST", M("/closings/prepare"), { token, body: { businessDate: D_STALE } });
    const stDraft = r.json.draft.id;
    await req("POST", M(`/closing-drafts/${stDraft}/counts`), { token, body: { clientCountId: uuid(), mode: "total", countedTotalVnd: 300000 } });
    r = await req("POST", M(`/closing-drafts/${stDraft}/preview`), { token, body: {} });
    const stPrev = r.json;
    // A new cash bill lands between preview and confirm.
    await seedCashDay(pool, merchantId, userId, D_STALE, { bills: [50000], tag: "st2" });
    r = await req("POST", M(`/closing-drafts/${stDraft}/confirm`), { token, idem: uuid(), body: { previewHash: stPrev.previewHash, countVersion: stPrev.countVersion, responsibilityConfirmed: true } });
    ok("confirm on drifted source → 409 (no chốt)", r.status === 409 && r.json.code === "CLOSING_SOURCE_CHANGED", r.json);

    // ── CLS-10 + CLS-11: late source after confirm → attention + reclose rev2 ─
    // A new cash bill (150k) lands on the already-confirmed balanced day.
    await seedCashDay(pool, merchantId, userId, D_BAL, { bills: [150000], tag: "late" });
    r = await req("POST", M(`/closings/${balPreview.closingId}/attention/scan`), { token });
    ok("scan detects exactly ONE late source", r.status === 200 && r.json.detected === 1 && r.json.status === "attention", r.json);
    // Idempotent: a second scan detects 0 more.
    r = await req("POST", M(`/closings/${balPreview.closingId}/attention/scan`), { token });
    ok("re-scan is idempotent (0 new)", r.json.detected === 0, r.json);
    r = await req("GET", M(`/closings/${balPreview.closingId}`), { token });
    ok("closing now 'attention' with 1 open item", r.json.closing.status === "attention" && r.json.openAttentionCount === 1, r.json);
    // Re-close (revision 2): prepare a new draft (now expected 550.000), count, confirm.
    r = await req("POST", M("/closings/prepare"), { token, body: { businessDate: D_BAL } });
    const balDraft2 = r.json.draft.id;
    ok("reclose prepare: new draft, expected 550.000, isReclose", r.json.expected.expectedCashVnd === 550000 && r.json.draft.isReclose === true, r.json.expected);
    await req("POST", M(`/closing-drafts/${balDraft2}/counts`), { token, body: { clientCountId: uuid(), mode: "total", countedTotalVnd: 550000 } });
    r = await req("POST", M(`/closing-drafts/${balDraft2}/preview`), { token, body: {} });
    const p2 = r.json;
    r = await req("POST", M(`/closing-drafts/${balDraft2}/confirm`), { token, idem: uuid(), body: { previewHash: p2.previewHash, countVersion: p2.countVersion, responsibilityConfirmed: true } });
    ok("reclose → revision 2, chained to revision 1", r.status === 201 && r.json.revisionNo === 2, r.json);
    // Verify the chain + rev1 immutability + attention resolved.
    const rev1After = (await pool.query(`select expected_cash_vnd, counted_cash_vnd, variance_vnd, content_hash from public.closing_revisions where id=$1`, [balRev1])).rows[0];
    ok("revision 1 UNCHANGED after reclose (immutable)", Number(rev1After.expected_cash_vnd) === 400000 && Number(rev1After.counted_cash_vnd) === 400000 && Number(rev1After.variance_vnd) === 0, rev1After);
    const rev2 = (await pool.query(`select id, previous_revision_id from public.closing_revisions where closing_id=$1 and revision_no=2`, [balPreview.closingId])).rows[0];
    ok("revision 2 previous_revision_id → revision 1", rev2.previous_revision_id === balRev1, rev2);
    r = await req("GET", M(`/closings/${balPreview.closingId}`), { token });
    ok("closing back to 'confirmed', attention resolved, 2 revisions", r.json.closing.status === "confirmed" && r.json.openAttentionCount === 0 && r.json.revisions.length === 2, { st: r.json.closing.status, open: r.json.openAttentionCount, revs: r.json.revisions.length });

    // ── CLS-12: RLS cross-tenant — merchant B cannot read A's closing ────────
    r = await req("GET", `/v1/merchants/${merchantId}/closings/${balPreview.closingId}`, { token: tokenB });
    ok("cross-tenant GET closing → 403", r.status === 403, r.json);
    r = await req("POST", `/v1/merchants/${merchantId}/closings/prepare`, { token: tokenB, body: { businessDate: D_BAL } });
    ok("cross-tenant prepare → 403", r.status === 403, r.json);
    // Sanity: B has no access to A's merchant scope at all.
    ok("merchant B id differs from A", merchantIdB !== merchantId);
  } finally {
    await pool.end();
  }

  console.log(`\nF14 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("e2e crashed:", e); process.exit(1); });
