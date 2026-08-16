// Functional 12 live E2E (spec 12.3 P0 matrix). Seeds known mismatches in the
// throwaway test merchant, runs reconciliation and asserts: exact detection with
// correct impact (REC-01), no duplicate issues across reruns (REC-03), evidence
// immutability (REC-04), reason-gated dismiss (REC-10) + suppression, run-level
// idempotency, verify-before-close auto-resolve (REC-09), RLS cross-tenant (REC-13),
// and a read-only dry-run (no writes). NOT in `npm test` (.mjs, needs DB + server).
//
// Run: F12_BASE=http://localhost:<port> node --env-file=.env test/f12-e2e.mjs
// (server must be up with .env + a non-3000 PORT).
import pg from "pg";
import { ensureF12Merchant, ensureF12bMerchant } from "./f12-setup.mjs";

const BASE = process.env.F12_BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0;
function ok(cond, msg) { if (cond) { PASS++; console.log("  ✓", msg); } else { FAIL++; console.error("  ✗", msg); } }

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json };
}
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

async function main() {
  const A = await ensureF12Merchant();
  const B = await ensureF12bMerchant();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  const tag = Date.now().toString(36);
  const seeded = {};
  try {
    // Fresh recon state for merchant A (throwaway merchant only). Issues reference
    // runs (run_id FK, no cascade) so delete issues first; evidence/attempts cascade.
    await pool.query(`delete from public.reconciliation_issues where merchant_id=$1`, [A.merchantId]);
    await pool.query(`delete from public.reconciliation_runs where merchant_id=$1`, [A.merchantId]);

    console.log("\n[seed] known mismatches in the test merchant");
    // A: paid bill, no successful payment → ORDER_PAID_NO_PAYMENT (high)
    seeded.orderNoPay = (await pool.query(
      `insert into public.orders (merchant_id, order_number, status, subtotal_amount, discount_amount, total_amount, client_request_id, cashier_user_id, version, business_date, paid_at)
       values ($1,$2,'paid',100000,0,100000,gen_random_uuid(),$3,1,current_date,now()) returning id`,
      [A.merchantId, `F12-${tag}-A`, A.userId])).rows[0].id;
    // B: paid bill total 200k but captured 150k → ORDER_PAYMENT_TOTAL_MISMATCH (medium)
    seeded.orderMismatch = (await pool.query(
      `insert into public.orders (merchant_id, order_number, status, subtotal_amount, discount_amount, total_amount, client_request_id, cashier_user_id, version, business_date, paid_at)
       values ($1,$2,'paid',200000,0,200000,gen_random_uuid(),$3,1,current_date,now()) returning id`,
      [A.merchantId, `F12-${tag}-B`, A.userId])).rows[0].id;
    await pool.query(
      `insert into public.payments (merchant_id, order_id, method, status, amount, idempotency_key, paid_at)
       values ($1,$2,'cash','succeeded',150000,$3,now())`,
      [A.merchantId, seeded.orderMismatch, uuid()]);
    // C: draft bill with a successful payment → PAYMENT_ON_UNPAID_ORDER (high)
    seeded.orderOrphanPay = (await pool.query(
      `insert into public.orders (merchant_id, order_number, status, subtotal_amount, discount_amount, total_amount, client_request_id, cashier_user_id, version, business_date)
       values ($1,$2,'draft',50000,0,50000,gen_random_uuid(),$3,1,current_date) returning id`,
      [A.merchantId, `F12-${tag}-C`, A.userId])).rows[0].id;
    seeded.orphanPayment = (await pool.query(
      `insert into public.payments (merchant_id, order_id, method, status, amount, idempotency_key, paid_at)
       values ($1,$2,'cash','succeeded',50000,$3,now()) returning id`,
      [A.merchantId, seeded.orderOrphanPay, uuid()])).rows[0].id;
    // D: awaiting bill with an expired pending QR → STALE_PENDING_QR (low)
    seeded.orderStale = (await pool.query(
      `insert into public.orders (merchant_id, order_number, status, subtotal_amount, discount_amount, total_amount, client_request_id, cashier_user_id, version, business_date)
       values ($1,$2,'awaiting_payment',70000,0,70000,gen_random_uuid(),$3,1,current_date) returning id`,
      [A.merchantId, `F12-${tag}-D`, A.userId])).rows[0].id;
    seeded.stalePayment = (await pool.query(
      `insert into public.payments (merchant_id, order_id, method, status, amount, idempotency_key, created_at, expires_at)
       values ($1,$2,'qr','pending',70000,$3, now() - interval '2 hours', now() - interval '1 hour') returning id`,
      [A.merchantId, seeded.orderStale, uuid()])).rows[0].id;
    // E: posted purchase receipt with no accounting_event → RECEIPT_POSTED_NO_EVENT (medium)
    seeded.receipt = (await pool.query(
      `insert into public.purchase_receipts (merchant_id, receipt_number, status, received_at, subtotal_vnd, extra_cost_vnd, grand_total_vnd, row_version, created_by, posted_at)
       values ($1,$2,'posted',current_date,300000,0,300000,1,$3,now()) returning id`,
      [A.merchantId, `PN-F12-${tag}`, A.userId])).rows[0].id;

    const EXPECT = [
      { entity: seeded.orderNoPay, rule: "ORDER_PAID_NO_PAYMENT", impact: "high" },
      { entity: seeded.orderMismatch, rule: "ORDER_PAYMENT_TOTAL_MISMATCH", impact: "medium" },
      { entity: seeded.orphanPayment, rule: "PAYMENT_ON_UNPAID_ORDER", impact: "high" },
      { entity: seeded.stalePayment, rule: "STALE_PENDING_QR", impact: "low" },
      { entity: seeded.receipt, rule: "RECEIPT_POSTED_NO_EVENT", impact: "medium" },
    ];

    // ── REC-01: run detects exactly the seeded mismatches with correct impact ──
    console.log("\n[REC-01] run detection");
    const key1 = uuid();
    const run1 = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, {}, { "Idempotency-Key": key1 });
    ok(run1.status === 201 && run1.json.run.status === "completed", `run completed (${run1.status})`);
    ok((run1.json.run.counters.newIssues ?? 0) >= 5, `>=5 new issues (${run1.json.run.counters.newIssues})`);
    ok((run1.json.run.counters.rulesOk ?? 0) === run1.json.run.counters.rulesTotal, "all rules ran (no coverage gaps)");

    // Map active issues → {ruleId: {sourceId: issue}}
    const issuesResp = await call(A.token, "GET", `/v1/merchants/${A.merchantId}/reconciliation/issues?status=active`);
    const issues = issuesResp.json.issues;
    const detailByEntity = {};
    for (const iss of issues) {
      const d = await call(A.token, "GET", `/v1/merchants/${A.merchantId}/reconciliation/issues/${iss.id}`);
      for (const ev of d.json.evidence) detailByEntity[`${iss.ruleId}:${ev.sourceId}`] = { iss, detail: d.json };
    }
    for (const e of EXPECT) {
      const hit = detailByEntity[`${e.rule}:${e.entity}`];
      ok(!!hit, `detected ${e.rule} for seeded entity`);
      if (hit) ok(hit.iss.impact === e.impact, `  impact = ${e.impact} (got ${hit.iss.impact})`);
    }

    // ── REC-03: rerun creates NO duplicate active issues ──
    console.log("\n[REC-03] rerun dedup");
    const run2 = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, {}, { "Idempotency-Key": uuid() });
    ok((run2.json.run.counters.newIssues ?? -1) === 0, `rerun newIssues = 0 (${run2.json.run.counters.newIssues})`);
    ok((run2.json.run.counters.matchedIssues ?? 0) >= 5, `rerun matched >=5 (${run2.json.run.counters.matchedIssues})`);
    const dupCheck = await pool.query(
      `select fingerprint, count(*) c from public.reconciliation_issues
        where merchant_id=$1 and status = any($2::text[]) group by fingerprint having count(*) > 1`,
      [A.merchantId, ["detected", "in_review", "action_pending", "failed"]]);
    ok(dupCheck.rows.length === 0, "no fingerprint has >1 active issue");

    // ── run-level idempotency: same key replays the same run ──
    console.log("\n[idem] same Idempotency-Key replays the run");
    const replay = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, {}, { "Idempotency-Key": key1 });
    ok(replay.json.replayed === true && replay.json.run.id === run1.json.run.id, "replayed same run id");

    // ── REC-04: evidence is immutable across reruns (snapshot preserved) ──
    console.log("\n[REC-04] evidence immutability");
    const aHit = detailByEntity[`ORDER_PAID_NO_PAYMENT:${seeded.orderNoPay}`];
    const evBefore = aHit.detail.evidence;
    const dAgain = await call(A.token, "GET", `/v1/merchants/${A.merchantId}/reconciliation/issues/${aHit.iss.id}`);
    ok(dAgain.json.evidence.length === evBefore.length, `evidence count unchanged (${dAgain.json.evidence.length})`);
    ok(dAgain.json.evidence[0].contentHash === evBefore[0].contentHash, "evidence content hash stable");
    ok(dAgain.json.evidence[0].asOf === evBefore[0].asOf, "evidence as_of preserved (snapshot)");
    ok(dAgain.json.live.status === "still_mismatched", "live recheck: still mismatched");

    // ── REC-10: dismiss requires a reason, then suppresses re-creation ──
    console.log("\n[REC-10] dismiss reason gate + suppression");
    const bHit = detailByEntity[`ORDER_PAYMENT_TOTAL_MISMATCH:${seeded.orderMismatch}`];
    const noReason = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${bHit.iss.id}/ignore`, { intentId: uuid() });
    ok(noReason.status === 400 && noReason.json.code === "RECON_REASON_REQUIRED", `dismiss w/o reason blocked (${noReason.json?.code})`);
    const dismissed = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${bHit.iss.id}/ignore`,
      { reasonCode: "KNOWN_OK", intentId: uuid(), expectedVersion: bHit.iss.rowVersion });
    ok(dismissed.status === 200 && dismissed.json.issue.status === "dismissed", "dismiss succeeded");
    const run3 = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, {}, { "Idempotency-Key": uuid() });
    const afterDismiss = await pool.query(
      `select status from public.reconciliation_issues where id=$1`, [bHit.iss.id]);
    ok(afterDismiss.rows[0].status === "dismissed", "dismissed issue not reopened by rerun");
    void run3;

    // ── transitions: review → action (idempotent by intent) ──
    console.log("\n[transitions] review + action + version conflict");
    const cHit = detailByEntity[`PAYMENT_ON_UNPAID_ORDER:${seeded.orphanPayment}`];
    const reviewed = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${cHit.iss.id}/review`, { expectedVersion: cHit.iss.rowVersion });
    ok(reviewed.status === 200 && reviewed.json.issue.status === "in_review", "review → in_review");
    const stale = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${cHit.iss.id}/review`, { expectedVersion: 999 });
    ok(stale.status === 409 && stale.json.code === "VERSION_CONFLICT", "stale version → 409");
    const intent = uuid();
    const cmd = reviewed.json.issue.command;
    const act1 = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${cHit.iss.id}/action`,
      { actionType: cmd, intentId: intent, expectedVersion: reviewed.json.issue.rowVersion });
    ok(act1.status === 200 && act1.json.issue.status === "action_pending", "action → action_pending");
    const act2 = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${cHit.iss.id}/action`,
      { actionType: cmd, intentId: intent });
    ok(act2.json.attempts.length === act1.json.attempts.length, "same intent replays (no 2nd attempt)");
    const badAct = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/issues/${cHit.iss.id}/action`,
      { actionType: "not_a_command", intentId: uuid() });
    ok(badAct.status === 400 && badAct.json.code === "RECON_INVALID_ACTION", "invalid action rejected");

    // ── REC-09: fix the source, rerun verifies-and-closes ──
    console.log("\n[REC-09] verify-before-close auto-resolve");
    await pool.query(
      `insert into public.payments (merchant_id, order_id, method, status, amount, idempotency_key, paid_at)
       values ($1,$2,'cash','succeeded',100000,$3,now())`,
      [A.merchantId, seeded.orderNoPay, uuid()]);
    await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, {}, { "Idempotency-Key": uuid() });
    const aResolved = await pool.query(`select status from public.reconciliation_issues where id=$1`, [aHit.iss.id]);
    ok(aResolved.rows[0].status === "resolved", `fixed source auto-resolved (${aResolved.rows[0].status})`);

    // ── REC-13: RLS cross-tenant — merchant B cannot read merchant A's issue ──
    console.log("\n[REC-13] RLS cross-tenant");
    const cross = await call(B.token, "GET", `/v1/merchants/${A.merchantId}/reconciliation/issues/${cHit.iss.id}`);
    ok(cross.status === 403, `cross-tenant issue read → 403 (${cross.status})`);
    const crossRun = await call(B.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, {}, { "Idempotency-Key": uuid() });
    ok(crossRun.status === 403, `cross-tenant run → 403 (${crossRun.status})`);

    // ── dry-run: read-only, writes nothing ──
    console.log("\n[dry-run] read-only, no writes");
    const runsBefore = (await pool.query(`select count(*)::int c from public.reconciliation_runs where merchant_id=$1`, [A.merchantId])).rows[0].c;
    const dry = await call(A.token, "POST", `/v1/merchants/${A.merchantId}/reconciliation/runs`, { dryRun: true }, { "Idempotency-Key": uuid() });
    ok(dry.json?.dryRun === true && Array.isArray(dry.json.findings), "dry-run returns findings");
    const runsAfter = (await pool.query(`select count(*)::int c from public.reconciliation_runs where merchant_id=$1`, [A.merchantId])).rows[0].c;
    ok(runsBefore === runsAfter, "dry-run created no run row");

    console.log(`\n${FAIL === 0 ? "ALL PASS" : "FAILURES"}: ${PASS} passed, ${FAIL} failed`);
  } finally {
    await pool.end();
  }
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E crashed:", e); process.exit(1); });
