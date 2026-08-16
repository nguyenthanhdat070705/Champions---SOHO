// Functional 12 — the rule runner (spec 6 REC-FR-01/02/03/04/10, 7.1 atomic
// detect). ONE Postgres transaction over the pooler (F3 pattern) does the whole
// run: fix as_of, execute every rule, fingerprint each match, materialise/dedupe
// issues + immutable evidence, auto-resolve issues whose invariant cleared, and
// finalise the run counters. The pooler bypasses RLS so the caller was already
// authorised (JWT + owner/manager membership) in the router.
//
// Invariants:
//   • Run idempotency: (merchant_id, idempotency_key) unique → a retried run
//     replays the same run row, it does not re-detect (spec 5.1).
//   • Issue dedupe: the recon_one_active_fingerprint partial unique index means a
//     rerun that sees the same mismatch appends evidence to the SAME active issue,
//     never a duplicate (spec 4.2 / REC-03). Concurrent runs serialise on the index.
//   • Evidence immutable: rows are insert-only; identical facts (same content_hash)
//     are appended once, changed facts record genuine drift (spec 4.2 / REC-04).
//   • Verify-before-close: an active issue NOT re-detected by a rule that ran
//     cleanly this run has its invariant cleared → auto-resolved (spec 4.3 / REC-09).
//     Rules that errored do NOT resolve their issues (coverage incomplete, REC-12).
//   • Dismiss durability: a dismissed fingerprint is not re-created (MVP has no
//     expiry column, so dismiss = permanent suppression).
import { randomUUID } from "node:crypto";
import { withTransaction, query } from "../db/pool.js";
import { writeAudit } from "../f3/audit.js";
import { fail } from "../f3/errors.js";
import { RULES, RULE_VERSION } from "./rules.js";
import { fingerprint, contentHash } from "./fingerprint.js";

const ACTIVE_STATUSES = ["detected", "in_review", "action_pending", "failed"];

function emptyCounters() {
  return {
    ruleSetVersion: RULE_VERSION,
    rulesTotal: RULES.length,
    rulesOk: 0,
    rulesFailed: 0,
    checked: 0,       // total mismatches found across all rules
    newIssues: 0,     // issues created this run
    matchedIssues: 0, // pre-existing active issues re-seen
    resolved: 0,      // active issues auto-closed (invariant cleared)
    byFamily: {},
    byImpact: { low: 0, medium: 0, high: 0 },
    errors: [],       // [{ ruleId, message }] — partial-run coverage (REC-12)
  };
}

function mapRun(r) {
  return {
    id: r.id,
    scope: r.scope,
    asOf: r.as_of,
    ruleSetVersion: r.rule_set_version,
    status: r.status,
    counters: r.counters,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/**
 * DRY-RUN (spec: read-only validation over real merchants). Executes every rule
 * detector and returns the counts + sample findings WITHOUT writing runs, issues
 * or evidence. Safe to point at production merchants.
 */
export async function dryRun(merchantId, { asOf } = {}) {
  const at = asOf || new Date().toISOString();
  const counters = emptyCounters();
  const findings = [];
  for (const rule of RULES) {
    try {
      const { rows } = await query(rule.detectSql, [merchantId, at]);
      counters.rulesOk += 1;
      for (const row of rows) {
        const m = rule.map(row);
        counters.checked += 1;
        counters.byImpact[rule.impact] += 1;
        counters.byFamily[rule.family] = (counters.byFamily[rule.family] || 0) + 1;
        findings.push({ ruleId: rule.id, family: rule.family, impact: rule.impact, entityKey: m.entityKey, facts: m.facts });
      }
    } catch (e) {
      counters.rulesFailed += 1;
      counters.errors.push({ ruleId: rule.id, message: String(e.message || e) });
    }
  }
  return { dryRun: true, merchantId, asOf: at, counters, findings };
}

/**
 * Create + execute a reconciliation run (spec 7.1 detect). Idempotent per
 * (merchant, Idempotency-Key). Returns { run, replayed }.
 */
export async function createRun(merchantId, userId, { scope, dryRun: dry } = {}, idemKey) {
  if (dry) return dryRun(merchantId, {});

  const key = idemKey || randomUUID();
  const scopeObj = scope && typeof scope === "object" ? scope : { sources: "all", window: "all" };

  return withTransaction(async (client) => {
    // 1 ── Idempotent run row. A retried key replays the SAME run (no re-detect).
    const ins = await client.query(
      `insert into public.reconciliation_runs
         (merchant_id, scope, as_of, rule_set_version, status, counters, idempotency_key, created_by)
       values ($1,$2, now(), $3, 'running', '{}'::jsonb, $4, $5)
       on conflict (merchant_id, idempotency_key) do nothing
       returning id, as_of`,
      [merchantId, JSON.stringify(scopeObj), RULE_VERSION, key, userId],
    );
    if (ins.rows.length === 0) {
      const ex = await client.query(
        `select * from public.reconciliation_runs where merchant_id=$1 and idempotency_key=$2`,
        [merchantId, key]);
      return { run: mapRun(ex.rows[0]), replayed: true };
    }
    const runId = ins.rows[0].id;
    const asOf = ins.rows[0].as_of;

    const counters = emptyCounters();
    const seen = new Set();      // fingerprints matched this run
    const okRuleIds = [];        // rules that ran without error (for auto-resolve)

    // 2 ── Run every rule; fingerprint + upsert issue + append evidence.
    for (const rule of RULES) {
      let rows;
      try {
        ({ rows } = await client.query(rule.detectSql, [merchantId, asOf]));
      } catch (e) {
        counters.rulesFailed += 1;
        counters.errors.push({ ruleId: rule.id, message: String(e.message || e) });
        continue;
      }
      counters.rulesOk += 1;
      okRuleIds.push(rule.id);

      for (const row of rows) {
        const m = rule.map(row);
        const fp = fingerprint(rule.id, RULE_VERSION, m.entityKey);
        seen.add(fp);
        counters.checked += 1;

        // Respect a prior dismiss (no expiry in MVP → permanent suppression).
        const dism = await client.query(
          `select 1 from public.reconciliation_issues
            where merchant_id=$1 and fingerprint=$2 and status='dismissed' limit 1`,
          [merchantId, fp]);
        if (dism.rows.length) continue;

        // Insert the issue only if there is no active one with this fingerprint.
        // The partial unique index is the concurrency guard (REC-03): a racing run
        // blocks here then falls through to the "existing" branch below.
        const created = await client.query(
          `insert into public.reconciliation_issues
             (merchant_id, run_id, rule_id, rule_version, fingerprint, issue_type, impact, status)
           values ($1,$2,$3,$4,$5,$6,$7,'detected')
           on conflict (merchant_id, fingerprint)
             where status in ('detected','in_review','action_pending','failed')
             do nothing
           returning id`,
          [merchantId, runId, rule.id, RULE_VERSION, fp, rule.family, rule.impact]);

        let issueId;
        let isNew;
        if (created.rows.length) {
          issueId = created.rows[0].id;
          isNew = true;
          counters.newIssues += 1;
          counters.byImpact[rule.impact] += 1;
          counters.byFamily[rule.family] = (counters.byFamily[rule.family] || 0) + 1;
        } else {
          const ex = await client.query(
            `select id from public.reconciliation_issues
              where merchant_id=$1 and fingerprint=$2 and status = any($3) limit 1`,
            [merchantId, fp, ACTIVE_STATUSES]);
          if (ex.rows.length === 0) continue; // dismissed/resolved-in-race → skip
          issueId = ex.rows[0].id;
          isNew = false;
          counters.matchedIssues += 1;
        }

        // Evidence: insert-only, deduped by content_hash (spec 4.2). A rerun with
        // identical facts adds nothing; changed facts record drift.
        const ch = contentHash(m.facts);
        const dup = await client.query(
          `select 1 from public.reconciliation_evidence where issue_id=$1 and content_hash=$2 limit 1`,
          [issueId, ch]);
        if (dup.rows.length === 0) {
          await client.query(
            `insert into public.reconciliation_evidence
               (merchant_id, issue_id, source_type, source_id, source_version, facts, as_of, content_hash, mask_policy)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'default')`,
            [merchantId, issueId, m.source.type, m.source.id, m.source.version,
             JSON.stringify(m.facts), asOf, ch]);
        }

        if (isNew) {
          await writeAudit(client, {
            merchantId, actorUserId: userId, action: "recon.issue_detected",
            entityType: "reconciliation_issue", entityId: issueId,
            after: { runId, ruleId: rule.id, fingerprint: fp, impact: rule.impact, family: rule.family },
          });
        }
      }
    }

    // 3 ── Auto-resolve: an active issue NOT re-detected by a rule that ran cleanly
    // has had its invariant cleared → close it (spec 4.3 verify-before-close). Rules
    // that errored are excluded so an incomplete scan never falsely resolves (REC-12).
    if (okRuleIds.length) {
      const active = await client.query(
        `select id, fingerprint, rule_id from public.reconciliation_issues
          where merchant_id=$1 and status = any($2) and rule_id = any($3)`,
        [merchantId, ACTIVE_STATUSES, okRuleIds]);
      for (const iss of active.rows) {
        if (seen.has(iss.fingerprint)) continue;
        await client.query(
          `update public.reconciliation_issues
              set status='resolved', resolved_at=now(), row_version=row_version+1 where id=$1`,
          [iss.id]);
        counters.resolved += 1;
        await writeAudit(client, {
          merchantId, actorUserId: userId, action: "recon.issue_resolved",
          entityType: "reconciliation_issue", entityId: iss.id,
          after: { runId, reason: "invariant_cleared" },
        });
      }
    }

    // 4 ── Finalise. 'failed' only if EVERY rule errored (no coverage at all);
    // otherwise 'completed' with per-rule errors recorded in counters (partial).
    const status = counters.rulesOk === 0 ? "failed" : "completed";
    const upd = await client.query(
      `update public.reconciliation_runs set status=$2, counters=$3 where id=$1 returning *`,
      [runId, status, JSON.stringify(counters)]);

    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "recon.run_completed",
      entityType: "reconciliation_run", entityId: runId,
      after: { status, checked: counters.checked, newIssues: counters.newIssues,
        matchedIssues: counters.matchedIssues, resolved: counters.resolved, errors: counters.errors.length },
    });

    return { run: mapRun(upd.rows[0]), replayed: false };
  });
}

/** GET /reconciliation/runs — recent runs with counters (spec 3.8). */
export async function listRuns(merchantId, { limit } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { rows } = await query(
    `select * from public.reconciliation_runs
      where merchant_id=$1 order by created_at desc limit $2`,
    [merchantId, lim]);
  return { runs: rows.map(mapRun) };
}

/** GET /reconciliation/runs/:id — one run (spec 3.8). */
export async function getRun(merchantId, runId) {
  const { rows } = await query(
    `select * from public.reconciliation_runs where merchant_id=$1 and id=$2`, [merchantId, runId]);
  if (rows.length === 0) fail("RECON_RUN_NOT_FOUND");
  return { run: mapRun(rows[0]) };
}
