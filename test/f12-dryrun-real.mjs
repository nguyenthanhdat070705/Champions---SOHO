// Functional 12 — DRY-RUN reconciliation over the two REAL merchants (read-only).
// Exercises every rule detector against production data and logs the findings
// WITHOUT writing runs/issues/evidence (dryRun bypasses all inserts). This is the
// brief's "validate against live data, log-only" channel. Run:
//   node --env-file=.env test/f12-dryrun-real.mjs
import { dryRun } from "../server/f12/engine.js";
import { closePool } from "../server/db/pool.js";
import { REAL_MERCHANTS } from "./f12-setup.mjs";

async function main() {
  for (const mid of REAL_MERCHANTS) {
    const r = await dryRun(mid, {});
    console.log(`\n=== merchant ${mid} · as_of ${r.asOf} ===`);
    console.log(`rules ok=${r.counters.rulesOk}/${r.counters.rulesTotal} failed=${r.counters.rulesFailed}`);
    console.log(`checked=${r.counters.checked}  byImpact=${JSON.stringify(r.counters.byImpact)}  byFamily=${JSON.stringify(r.counters.byFamily)}`);
    if (r.counters.errors.length) console.log("errors:", JSON.stringify(r.counters.errors));
    const byRule = {};
    for (const f of r.findings) byRule[f.ruleId] = (byRule[f.ruleId] || 0) + 1;
    console.log("byRule:", JSON.stringify(byRule));
    // Show up to 3 sample findings (entity keys + facts) for eyeballing — no PII.
    for (const f of r.findings.slice(0, 3)) {
      console.log(`  · ${f.ruleId} [${f.impact}] ${f.entityKey}`);
    }
  }
  await closePool();
  console.log("\n(dry-run complete — no rows written)");
}
main().catch((e) => { console.error("dry-run crashed:", e); process.exit(1); });
