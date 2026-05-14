/**
 * One-shot script: trigger every live ingestor and print a results table.
 * Run with: pnpm --filter @workspace/api-server exec tsx src/scripts/refresh-all-sources.ts
 */
import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor.js";
import { ingestConFilings } from "../services/conFilingsIngestor.js";
import { ingestNppes } from "../services/nppesIngestor.js";
import { ingestFda510k } from "../services/fda510kIngestor.js";
import { ingestFdaRecalls } from "../services/fdaRecallsIngestor.js";
import { ingestFdaMaude } from "../services/fdaMaudeIngestor.js";
import { ingestFdaClassification } from "../services/fdaClassificationIngestor.js";
import { ingestPropublica990 } from "../services/propublica990Ingestor.js";
import { ingestCmsData } from "../services/cmsDataIngestor.js";
import { ingestSecEdgar } from "../services/secEdgarIngestor.js";
import { ingestUsaSpending } from "../services/usaSpendingIngestor.js";
import { ingestSamGov } from "../services/samGovIngestor.js";
import { ingestEmma } from "../services/emmaIngestor.js";
import { ingestHcris } from "../services/hcrisIngestor.js";
import { ingestHrsa } from "../services/hrsaIngestor.js";
import { ingestUsda } from "../services/usdaIngestor.js";
import { ingestMedicareUtil } from "../services/medicareUtilIngestor.js";
import { recomputeAllScores } from "../services/signalScorer.js";

interface IngestResult {
  source: string;
  status: "ok" | "error";
  signalsInserted?: number;
  errors?: number;
  extra?: Record<string, unknown>;
  errorMsg?: string;
  durationMs: number;
}

async function run(
  label: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<IngestResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return {
      source: label,
      status: "ok",
      signalsInserted: (r.signalsInserted as number | undefined) ?? (r.inserted as number | undefined),
      errors: (r.errors as number | undefined),
      extra: Object.fromEntries(
        Object.entries(r).filter(([k]) => !["signalsInserted", "inserted", "errors"].includes(k)),
      ),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      source: label,
      status: "error",
      errorMsg: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}

const total0 = Date.now();
console.log("\n🔄  MedIntel OS — Refreshing all live data sources\n");

// ── Run ingestors in parallel batches ──────────────────────────────────────
// Batch 1: CON filings + ClinicalTrials (independent of free APIs)
console.log("Batch 1: CON Filings + Clinical Trials…");
const [conResult, ctResult] = await Promise.all([
  run("CON Filings (all states)", () => ingestConFilings() as Promise<Record<string, unknown>>),
  run("Clinical Trials", () => ingestClinicalTrials({ limit: 100 }) as Promise<Record<string, unknown>>),
]);

// Batch 2: All 15 free-API sources in parallel
console.log("Batch 2: Free API sources (15 sources in parallel)…");
const freeApiResults = await Promise.all([
  run("NPPES",           () => ingestNppes({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("FDA 510(k)",      () => ingestFda510k({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("FDA Recalls",     () => ingestFdaRecalls({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("FDA MAUDE",       () => ingestFdaMaude({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("FDA Classification", () => ingestFdaClassification({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("ProPublica 990",  () => ingestPropublica990({ limit: 40 }) as Promise<Record<string, unknown>>),
  run("CMS Data",        () => ingestCmsData({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("SEC EDGAR",       () => ingestSecEdgar({ limit: 40 }) as Promise<Record<string, unknown>>),
  run("USA Spending",    () => ingestUsaSpending({ limit: 40 }) as Promise<Record<string, unknown>>),
  run("SAM.gov",         () => ingestSamGov({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("EMMA Bonds",      () => ingestEmma({ limit: 30 }) as Promise<Record<string, unknown>>),
  run("HCRIS",           () => ingestHcris({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("HRSA",            () => ingestHrsa({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("USDA",            () => ingestUsda({ limit: 50 }) as Promise<Record<string, unknown>>),
  run("Medicare Util",   () => ingestMedicareUtil({ limit: 50 }) as Promise<Record<string, unknown>>),
]);

// Batch 3: Recompute scores after fresh data
console.log("Batch 3: Recomputing signal scores…");
const scoreResult = await run(
  "Signal Score Recompute",
  () => recomputeAllScores() as Promise<Record<string, unknown>>,
);

// ── Print results table ────────────────────────────────────────────────────
const allResults: IngestResult[] = [conResult, ctResult, ...freeApiResults, scoreResult];

const ok = allResults.filter((r) => r.status === "ok");
const failed = allResults.filter((r) => r.status === "error");
const totalSignals = ok.reduce((n, r) => n + (r.signalsInserted ?? 0), 0);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

for (const r of allResults) {
  const icon = r.status === "ok" ? "✅" : "❌";
  const sig = r.signalsInserted != null ? `  +${r.signalsInserted} signals` : "";
  const err = r.errors ? `  ⚠ ${r.errors} partial errors` : "";
  const ms  = `  (${(r.durationMs / 1000).toFixed(1)}s)`;
  if (r.status === "ok") {
    const extraKeys = Object.keys(r.extra ?? {});
    const extraStr = extraKeys.length
      ? "  " + extraKeys.map((k) => `${k}=${(r.extra as Record<string, unknown>)[k]}`).join(", ")
      : "";
    console.log(`${icon}  ${r.source}${sig}${err}${extraStr}${ms}`);
  } else {
    console.log(`${icon}  ${r.source}  — ${r.errorMsg}${ms}`);
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${ok.length}/${allResults.length} sources succeeded`);
console.log(`  ${totalSignals} total new signals inserted`);
if (failed.length > 0) {
  console.log(`  ${failed.length} failed: ${failed.map((r) => r.source).join(", ")}`);
}
console.log(`  Total elapsed: ${((Date.now() - total0) / 1000).toFixed(1)}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

process.exit(failed.length > 0 ? 1 : 0);
