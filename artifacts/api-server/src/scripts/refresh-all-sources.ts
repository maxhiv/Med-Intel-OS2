/**
 * One-shot script: trigger every live ingestor via the existing manual API
 * endpoints and print a results table.
 *
 * Prerequisites:
 *   - INTERNAL_ADMIN_KEY env var must be set (used to authenticate)
 *   - PORT env var must be set (API server port, e.g. 8080)
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/refresh-all-sources.ts
 */

export {};

const internalKey = process.env.INTERNAL_ADMIN_KEY;
if (!internalKey) {
  console.error("ERROR: INTERNAL_ADMIN_KEY env var is required");
  process.exit(1);
}

const port = process.env.PORT ?? "8080";
const BASE = `http://localhost:${port}/api`;
const headers = {
  "Content-Type": "application/json",
  "x-internal-admin-key": internalKey,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RunResult {
  source: string;
  status: "ok" | "error";
  body?: Record<string, unknown>;
  httpStatus?: number;
  errorMsg?: string;
  durationMs: number;
}

async function post(label: string, path: string): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers });
    const durationMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { source: label, status: "error", httpStatus: res.status, errorMsg: text.slice(0, 120), durationMs };
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { source: label, status: "ok", httpStatus: res.status, body, durationMs };
  } catch (err) {
    return { source: label, status: "error", errorMsg: String(err), durationMs: Date.now() - t0 };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const total0 = Date.now();
console.log("\n🔄  MedIntel OS — Refreshing all live data sources via API\n");

// Batch 1: CON Filings (all states) + ClinicalTrials — run in parallel
console.log("Batch 1: CON Filings (all states) + Clinical Trials…");
const [conAll, ct] = await Promise.all([
  post("CON Filings (all states)", "/signals/ingest/con-filings"),
  post("Clinical Trials",          "/signals/ingest/clinicaltrials"),
]);

// Batch 2: All 15 free-API sources in parallel
console.log("Batch 2: 15 free API sources in parallel…");
const FREE_SOURCES = [
  "nppes", "fda_510k", "fda_recalls", "fda_maude", "fda_class",
  "propublica_990", "cms_data", "sec_edgar", "usa_spending",
  "sam_gov", "emma_bonds", "hcris", "hrsa", "usda", "medicare_util",
] as const;

const freeResults = await Promise.all(
  FREE_SOURCES.map((src) =>
    post(src, `/signals/ingest/free-apis?source=${src}`),
  ),
);

// Batch 3: Recompute composite scores
console.log("Batch 3: Recomputing signal scores…");
const scoreResult = await post("Signal Score Recompute", "/signals/recompute");

// ─── Report ───────────────────────────────────────────────────────────────────

const allResults: RunResult[] = [conAll, ct, ...freeResults, scoreResult];
const ok      = allResults.filter((r) => r.status === "ok");
const failed  = allResults.filter((r) => r.status === "error");

// Count total new signals across all results
function signalsFrom(r: RunResult): number {
  if (!r.body) return 0;
  const b = r.body as Record<string, unknown>;
  // Top-level response
  if (typeof b.signalsInserted === "number") return b.signalsInserted;
  // free-apis endpoint wraps results per-source
  return Object.values(b).reduce<number>((n, v) => {
    if (v && typeof (v as Record<string, unknown>).signalsInserted === "number") {
      return n + ((v as Record<string, unknown>).signalsInserted as number);
    }
    return n;
  }, 0);
}

const totalSignals = ok.reduce((n, r) => n + signalsFrom(r), 0);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

for (const r of allResults) {
  const icon   = r.status === "ok" ? "✅" : "❌";
  const ms     = `(${(r.durationMs / 1000).toFixed(1)}s)`;
  const sigs   = signalsFrom(r);
  const sigStr = sigs > 0 ? `  +${sigs} signals` : "";

  if (r.status === "ok") {
    const b = r.body ?? {};
    // For con-filings, show per-state breakdown if available
    if (b.perState && typeof b.perState === "object") {
      const perState = b.perState as Record<string, { fetched: number; inserted: number; signals: number }>;
      const stateLines = Object.entries(perState)
        .filter(([, v]) => v.fetched > 0)
        .map(([st, v]) => `${st}: ${v.fetched} fetched, ${v.signals} signals`)
        .join(" | ");
      const noData = Object.entries(perState).filter(([, v]) => v.fetched === 0).map(([s]) => s).join(", ");
      console.log(`${icon}  ${r.source}${sigStr}  ${ms}`);
      if (stateLines)  console.log(`     Active:  ${stateLines}`);
      if (noData)      console.log(`     No data: ${noData}`);
    } else if (typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0) {
      // For free-apis single-source results, show errors count if any
      const errCnt = typeof b.errors === "number" ? b.errors : 0;
      const errStr = errCnt > 0 ? `  ⚠ ${errCnt} partial errors` : "";
      console.log(`${icon}  ${r.source}${sigStr}${errStr}  ${ms}`);
    } else {
      console.log(`${icon}  ${r.source}${sigStr}  ${ms}`);
    }
  } else {
    const code = r.httpStatus ? ` HTTP ${r.httpStatus}` : "";
    console.log(`${icon}  ${r.source}${code}  — ${r.errorMsg ?? "unknown error"}  ${ms}`);
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${ok.length}/${allResults.length} sources succeeded`);
console.log(`  ~${totalSignals} total new signals inserted`);
if (failed.length > 0) {
  console.log(`  ${failed.length} failed: ${failed.map((r) => r.source).join(", ")}`);
}
console.log(`  Total elapsed: ${((Date.now() - total0) / 1000).toFixed(1)}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

process.exit(failed.length > 0 ? 1 : 0);
