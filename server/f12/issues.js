// Functional 12 — issue reads + resolution transitions (spec 3.1/3.2/3.3/3.6,
// 6 REC-FR-05..09, 7.1). Reads render evidence + a LIVE recheck (snapshot vs
// current invariant) so the UI can warn when the source moved (spec 3.3 / REC-04).
// Every transition is server-validated (spec 9.1: status only via trusted code,
// no free PATCH), optimistic-locked on row_version, and audited.
//
// MVP boundary (spec 1.3 / product decision): F12 NEVER mutates F03–F11 data. A
// resolution records the INTENT (a handoff command + audit) and points the user at
// the owner flow; the mismatch is verified-closed on the NEXT run when the rule no
// longer fires (engine auto-resolve). Dismiss is the only user-driven close, and
// always needs a reason (spec 4.2 / REC-10).
import { randomUUID } from "node:crypto";
import { withTransaction, query } from "../db/pool.js";
import { writeAudit } from "../f3/audit.js";
import { DomainError, fail } from "../f3/errors.js";
import { RULES, RULES_BY_ID } from "./rules.js";
import { contentHash } from "./fingerprint.js";

const ACTIVE_STATUSES = ["detected", "in_review", "action_pending", "failed"];
const isActive = (s) => ACTIVE_STATUSES.includes(s);

/** Derive the owner deep-link from an evidence facts blob (see rules.js targets). */
function deepLinkFor(facts) {
  if (!facts) return null;
  if (facts.orderId) return { kind: "order", route: `/don-hang/${facts.orderId}` };
  if (facts.productId) return { kind: "product", route: `/ton-kho/${facts.productId}` };
  if (facts.receiptId) return { kind: "receipt", route: `/nhap-hang/${facts.receiptId}` };
  if (facts.expenseId) return { kind: "expense", route: `/chi-phi/${facts.expenseId}` };
  return null;
}

/** Rule metadata + a human summary from the latest evidence facts. */
function enrichIssue(row, latestFacts) {
  const rule = RULES_BY_ID[row.rule_id];
  const facts = latestFacts || null;
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    family: row.issue_type,
    impact: row.impact,
    status: row.status,
    rowVersion: Number(row.row_version),
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    runId: row.run_id,
    title: rule ? rule.title : row.rule_id,
    summary: rule && facts ? rule.explain(facts) : null,
    command: rule ? rule.command : null,
    actionHint: rule ? rule.actionHint : null,
    deepLink: deepLinkFor(facts),
  };
}

/** GET /reconciliation/summary — data-cleanliness hero + family/impact counts (spec 3.1). */
export async function getSummary(merchantId) {
  const { rows: agg } = await query(
    `select issue_type, impact, count(*)::int as n
       from public.reconciliation_issues
      where merchant_id=$1 and status = any($2)
      group by issue_type, impact`,
    [merchantId, ACTIVE_STATUSES]);
  const byFamily = {}; const byImpact = { low: 0, medium: 0, high: 0 }; let total = 0;
  for (const r of agg) {
    byFamily[r.issue_type] = (byFamily[r.issue_type] || 0) + r.n;
    byImpact[r.impact] = (byImpact[r.impact] || 0) + r.n;
    total += r.n;
  }
  const { rows: last } = await query(
    `select id, as_of, status, counters, created_at from public.reconciliation_runs
      where merchant_id=$1 order by created_at desc limit 1`, [merchantId]);
  const { rows: resolvedCnt } = await query(
    `select count(*)::int as n from public.reconciliation_issues
      where merchant_id=$1 and status in ('resolved','dismissed')`, [merchantId]);

  return {
    active: { total, byFamily, byImpact },
    resolvedTotal: resolvedCnt[0].n,
    lastRun: last[0]
      ? { id: last[0].id, asOf: last[0].as_of, status: last[0].status, counters: last[0].counters, createdAt: last[0].created_at }
      : null,
  };
}

/** GET /reconciliation/issues — filtered queue (spec 3.2). Default = active only. */
export async function listIssues(merchantId, { status, family, impact, limit } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const params = [merchantId];
  let where = "i.merchant_id = $1";
  if (!status || status === "active") {
    params.push(ACTIVE_STATUSES); where += ` and i.status = any($${params.length})`;
  } else if (status !== "all") {
    params.push(status); where += ` and i.status = $${params.length}`;
  }
  if (family) { params.push(family); where += ` and i.issue_type = $${params.length}`; }
  if (impact) { params.push(impact); where += ` and i.impact = $${params.length}`; }
  params.push(lim);
  // Latest evidence facts per issue (for the card summary).
  const { rows } = await query(
    `select i.*, ev.facts as latest_facts
       from public.reconciliation_issues i
       left join lateral (
         select facts from public.reconciliation_evidence e
          where e.issue_id = i.id order by e.created_at desc limit 1
       ) ev on true
      where ${where}
      order by case i.impact when 'high' then 0 when 'medium' then 1 else 2 end,
               i.detected_at desc, i.id
      limit $${params.length}`,
    params);
  return { issues: rows.map((r) => enrichIssue(r, r.latest_facts)) };
}

/** GET /reconciliation/issues/:id — evidence panel + live recheck + attempts (spec 3.3/3.6). */
export async function getIssue(merchantId, issueId) {
  const head = await query(
    `select * from public.reconciliation_issues where merchant_id=$1 and id=$2`, [merchantId, issueId]);
  if (head.rows.length === 0) fail("RECON_ISSUE_NOT_FOUND");
  const row = head.rows[0];
  const rule = RULES_BY_ID[row.rule_id];

  const [ev, attempts] = await Promise.all([
    query(`select id, source_type, source_id, source_version, facts, as_of, content_hash, mask_policy, created_at
             from public.reconciliation_evidence where issue_id=$1 order by created_at`, [issueId]),
    query(`select id, action_type, intent_id, preview_hash, status, owner_operation_id, result_ref, reason, actor_id, created_at
             from public.reconciliation_resolution_attempts where issue_id=$1 order by created_at`, [issueId]),
  ]);
  const evidence = ev.rows.map((e) => ({
    id: e.id, sourceType: e.source_type, sourceId: e.source_id, sourceVersion: Number(e.source_version),
    facts: e.facts, asOf: e.as_of, contentHash: e.content_hash, maskPolicy: e.mask_policy, createdAt: e.created_at,
  }));
  const latestFacts = evidence.length ? evidence[evidence.length - 1].facts : null;

  // Live recheck: re-run this rule against the single entity as-of now (spec 3.3).
  // still_mismatched → the invariant persists; cleared → source was fixed (a rerun
  // will auto-resolve). Non-fatal: any error degrades to 'unknown'.
  let live = { status: "unknown", facts: null, changed: false };
  if (rule && latestFacts) {
    const entityId = evidence[evidence.length - 1].sourceId;
    try {
      const { rows } = await query(rule.recheckSql, [merchantId, entityId]);
      if (rows.length === 0) {
        live = { status: "cleared", facts: null, changed: true };
      } else {
        const curFacts = rule.map(rows[0]).facts;
        const changed = contentHash(curFacts) !== contentHash(latestFacts);
        live = { status: "still_mismatched", facts: curFacts, changed };
      }
    } catch {
      live = { status: "unknown", facts: null, changed: false };
    }
  }

  const actions = buildActions(rule, row.status);
  return {
    issue: enrichIssue(row, latestFacts),
    ruleExplain: rule && latestFacts ? rule.explain(latestFacts) : null,
    evidence,
    attempts: attempts.rows.map((a) => ({
      id: a.id, actionType: a.action_type, intentId: a.intent_id, status: a.status,
      ownerOperationId: a.owner_operation_id, resultRef: a.result_ref, reason: a.reason,
      actorId: a.actor_id, createdAt: a.created_at,
    })),
    live,
    actions,
  };
}

/** Allowed resolution actions for an issue given its rule + current status. */
function buildActions(rule, status) {
  if (!rule || !isActive(status)) return [];
  const out = [];
  if (status === "detected") out.push({ type: "mark_reviewed", label: "Đánh dấu đang xem" });
  // The owner-flow handoff (records intent; opens the native flow — MVP no auto-fix).
  out.push({ type: rule.command, label: "Chuyển xử lý", hint: rule.actionHint, kind: "handoff" });
  out.push({ type: "dismiss", label: "Bỏ qua (có lý do)", kind: "dismiss" });
  return out;
}

// ── transitions ──────────────────────────────────────────────────────────────
async function loadForUpdate(client, merchantId, issueId) {
  const { rows } = await client.query(
    `select * from public.reconciliation_issues where merchant_id=$1 and id=$2 for update`,
    [merchantId, issueId]);
  if (rows.length === 0) fail("RECON_ISSUE_NOT_FOUND");
  return rows[0];
}
function checkVersion(row, expected) {
  if (expected != null && Number(row.row_version) !== Number(expected)) {
    throw new DomainError("VERSION_CONFLICT", undefined, { current: { rowVersion: Number(row.row_version) } });
  }
}

/** POST /issues/:id/review — detected → in_review (triage, spec 2.1). Idempotent. */
export async function markReview(merchantId, userId, issueId, expectedVersion) {
  await withTransaction(async (client) => {
    const row = await loadForUpdate(client, merchantId, issueId);
    if (!isActive(row.status)) fail("RECON_ISSUE_NOT_ACTIVE");
    checkVersion(row, expectedVersion);
    if (row.status === "detected") {
      await client.query(
        `update public.reconciliation_issues set status='in_review', row_version=row_version+1 where id=$1`, [issueId]);
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "recon.issue_in_review",
        entityType: "reconciliation_issue", entityId: issueId, after: {} });
    }
  });
  return getIssue(merchantId, issueId);
}

/**
 * POST /issues/:id/action — record a resolution intent + hand off to the owner
 * flow (spec 3.5 / 7.1 / REC-FR-06/07). Idempotent by intent_id (the attempts
 * unique index): a retried intent replays the same attempt, never a second command.
 * MVP does NOT execute the command; it flips the issue to action_pending and the
 * next run verifies-and-closes it (spec 4.3).
 */
export async function requestAction(merchantId, userId, issueId, input) {
  const actionType = String(input?.actionType || "").trim();
  const intentId = input?.intentId || randomUUID();
  const previewHash = input?.previewHash ? String(input.previewHash) : contentHash({ issueId, actionType });
  const reason = input?.reason && typeof input.reason === "object" ? input.reason : { note: input?.reason || null };
  const expectedVersion = input?.expectedVersion;

  await withTransaction(async (client) => {
    const row = await loadForUpdate(client, merchantId, issueId);
    if (!isActive(row.status)) fail("RECON_ISSUE_NOT_ACTIVE");
    const rule = RULES_BY_ID[row.rule_id];
    if (!rule || actionType !== rule.command) fail("RECON_INVALID_ACTION");
    checkVersion(row, expectedVersion);

    const ins = await client.query(
      `insert into public.reconciliation_resolution_attempts
         (merchant_id, issue_id, action_type, intent_id, preview_hash, status, reason, actor_id)
       values ($1,$2,$3,$4,$5,'requested',$6,$7)
       on conflict (intent_id) do nothing
       returning id`,
      [merchantId, issueId, actionType, intentId, previewHash, JSON.stringify(reason), userId]);
    if (ins.rows.length === 0) return; // replay (same intent) — no second command

    if (row.status !== "action_pending") {
      await client.query(
        `update public.reconciliation_issues set status='action_pending', row_version=row_version+1 where id=$1`, [issueId]);
    }
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "recon.action_requested",
      entityType: "reconciliation_issue", entityId: issueId,
      after: { actionType, intentId, previewHash } });
  });
  return getIssue(merchantId, issueId);
}

/**
 * POST /issues/:id/ignore — dismiss with a required reason (spec 4.2 / REC-10).
 * Terminal + idempotent (a re-dismiss is a no-op). Evidence is NOT deleted.
 */
export async function ignoreIssue(merchantId, userId, issueId, input) {
  const reasonCode = String(input?.reasonCode || "").trim();
  const note = input?.note ? String(input.note).slice(0, 500) : "";
  if (!reasonCode && !note) fail("RECON_REASON_REQUIRED");
  const intentId = input?.intentId || randomUUID();
  const expectedVersion = input?.expectedVersion;
  const reason = { code: reasonCode || "OTHER", note };

  await withTransaction(async (client) => {
    const row = await loadForUpdate(client, merchantId, issueId);
    if (row.status === "dismissed") return; // idempotent
    if (!isActive(row.status)) fail("RECON_ISSUE_NOT_ACTIVE"); // e.g. already resolved
    checkVersion(row, expectedVersion);

    await client.query(
      `insert into public.reconciliation_resolution_attempts
         (merchant_id, issue_id, action_type, intent_id, preview_hash, status, reason, actor_id)
       values ($1,$2,'dismiss',$3,$4,'succeeded',$5,$6)
       on conflict (intent_id) do nothing`,
      [merchantId, issueId, intentId, contentHash({ issueId, action: "dismiss" }), JSON.stringify(reason), userId]);
    await client.query(
      `update public.reconciliation_issues
          set status='dismissed', resolved_at=now(), row_version=row_version+1 where id=$1`, [issueId]);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "recon.issue_ignored",
      entityType: "reconciliation_issue", entityId: issueId, after: { reason } });
  });
  return getIssue(merchantId, issueId);
}

/** Rule catalog for the UI (labels/impacts) — static, no tenant data. */
export function ruleCatalog() {
  return {
    ruleSetVersion: RULES[0]?.ruleVersion || "VN-2026.1",
    rules: RULES.map((r) => ({ id: r.id, family: r.family, impact: r.impact, title: r.title, command: r.command })),
  };
}
