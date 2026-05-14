/**
 * One-shot internal job: run every live ingestor and print a per-source
 * results table.
 *
 * Runs ingestors directly (same approach as the cron jobs in cron/index.ts)
 * so no HTTP auth bypass or shared secret is required. The script must be
 * executed on the same host with access to DATABASE_URL.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/refresh-all-sources.ts
 */

import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor";
import { ingestConFilings, buildAdapters } from "../services/conFilingsIngestor";
import { ingestNppes } from "../services/nppesIngestor";
import { ingestFda510k } from "../services/fda510kIngestor";
import { ingestFdaRecalls } from "../services/fdaRecallsIngestor";
import { ingestFdaMaude } from "../services/fdaMaudeIngestor";
import { ingestFdaClassification } from "../services/fdaClassificationIngestor";
import { ingestPropublica990 } from "../services/propublica990Ingestor";
import { ingestCmsData } from "../services/cmsDataIngestor";
import { ingestSecEdgar } from "../services/secEdgarIngestor";
import { ingestUsaSpending } from "../services/usaSpendingIngestor";
import { ingestSamGov } from "../services/samGovIngestor";
import { ingestEmma } from "../services/emmaIngestor";
import { ingestHcris } from "../services/hcrisIngestor";
import { ingestHrsa } from "../services/hrsaIngestor";
import { ingestUsda } from "../services/usdaIngestor";
import { ingestMedicareUtil } from "../services/medicareUtilIngestor";
import { recomputeAllScores } from "../services/signalScorer";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceResult {
  name: string;
  status: "ok" | "error";
  signalsInserted: number;
  errors: number;
  errorMsg?: string;
  durationMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function run(
  name: string,
  fn: () => Promise<{ signalsInserted: number; errors: number }>,
): Promise<SourceResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return {
      name,
      status: r.errors > 0 ? "error" : "ok",
      signalsInserted: r.signalsInserted,
      errors: r.errors,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      name,
      status: "error",
      signalsInserted: 0,
      errors: 1,
      errorMsg: String(err).slice(0, 200),
      durationMs: Date.now() - t0,
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const wallStart = Date.now();
console.log("\n🔄  MedIntel OS — Refreshing all live data sources\n");

// ── CON Filings: one call per state for independent per-state visibility ───────
const CON_STATES = ["IL", "NY", "FL", "NC", "GA", "MI", "OH", "CT"] as const;
const allAdapters = buildAdapters();

console.log(`Batch 1: CON Filings (${CON_STATES.join(", ")}) + Clinical Trials (parallel)…`);
const [ct, ...conResults] = await Promise.all([
  run("Clinical Trials", () => ingestClinicalTrials({ limit: 100 })),
  ...CON_STATES.map((st) => {
    const adapters = allAdapters.filter((a) => a.state === st);
    if (adapters.length === 0) {
      return Promise.resolve<SourceResult>({
        name: `CON Filings (${st})`,
        status: "error",
        signalsInserted: 0,
        errors: 1,
        errorMsg: "no adapter configured for this state",
        durationMs: 0,
      });
    }
    return run(`CON Filings (${st})`, () => ingestConFilings({ adapters }));
  }),
]);

// ── 15 free-API sources — parallel ────────────────────────────────────────────
console.log("Batch 2: 15 free-API sources (parallel)…");
const freeResults = await Promise.all([
  run("nppes",          () => ingestNppes({ limit: 50 })),
  run("fda_510k",       () => ingestFda510k({ limit: 50 })),
  run("fda_recalls",    () => ingestFdaRecalls({ limit: 50 })),
  run("fda_maude",      () => ingestFdaMaude({ limit: 50 })),
  run("fda_class",      () => ingestFdaClassification({ limit: 50 })),
  run("propublica_990", () => ingestPropublica990({ limit: 40 })),
  run("cms_data",       () => ingestCmsData({ limit: 50 })),
  run("sec_edgar",      () => ingestSecEdgar({ limit: 40 })),
  run("usa_spending",   () => ingestUsaSpending({ limit: 40 })),
  run("sam_gov",        () => ingestSamGov({ limit: 50 })),
  run("emma_bonds",     () => ingestEmma({ limit: 30 })),
  run("hcris",          () => ingestHcris({ limit: 50 })),
  run("hrsa",           () => ingestHrsa({ limit: 50 })),
  run("usda",           () => ingestUsda({ limit: 50 })),
  run("medicare_util",  () => ingestMedicareUtil({ limit: 50 })),
]);

// ── Score recompute ────────────────────────────────────────────────────────────
console.log("Batch 3: Recomputing signal scores…");
let scoreOk = false;
let scoreDurationMs = 0;
let scoreErr = "";
try {
  const t0 = Date.now();
  await recomputeAllScores();
  scoreDurationMs = Date.now() - t0;
  scoreOk = true;
} catch (err) {
  scoreErr = String(err).slice(0, 200);
}

// ─── Report ───────────────────────────────────────────────────────────────────

const allSourceResults: SourceResult[] = [ct, ...conResults, ...freeResults];
const ok     = allSourceResults.filter((r) => r.status === "ok");
const failed = allSourceResults.filter((r) => r.status === "error");
const totalSignals = allSourceResults.reduce((n, r) => n + r.signalsInserted, 0);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

for (const r of allSourceResults) {
  const ms     = `(${(r.durationMs / 1000).toFixed(1)}s)`;
  const sigs   = r.signalsInserted > 0 ? `  +${r.signalsInserted} signals` : "";
  const errs   = r.errors > 0 ? `  ⚠ ${r.errors} partial error(s)` : "";
  const icon   = r.status === "ok" ? "✅" : "❌";
  const errMsg = r.errorMsg ? `  — ${r.errorMsg}` : "";
  console.log(`${icon}  ${r.name}${sigs}${errs}${errMsg}  ${ms}`);
}

const scoreIcon = scoreOk ? "✅" : "❌";
const scoreMs   = `(${(scoreDurationMs / 1000).toFixed(1)}s)`;
const scoreNote = scoreOk ? "" : `  — ${scoreErr}`;
console.log(`${scoreIcon}  Signal Score Recompute${scoreNote}  ${scoreMs}`);

const exitCode = (failed.length > 0 || !scoreOk) ? 1 : 0;
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${ok.length}/${allSourceResults.length} sources succeeded`);
console.log(`  ~${totalSignals} total new signals inserted`);
if (failed.length > 0) {
  console.log(`  Failed: ${failed.map((r) => r.name).join(", ")}`);
}
console.log(`  Score recompute: ${scoreOk ? "ok" : "failed"}`);
console.log(`  Total elapsed: ${((Date.now() - wallStart) / 1000).toFixed(1)}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

process.exit(exitCode);
