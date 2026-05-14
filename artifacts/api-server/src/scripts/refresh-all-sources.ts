/**
 * One-shot script: trigger every live ingestor via the existing manual API
 * endpoints and print a per-source results table.
 *
 * Auth: the ingest endpoints accept requests from the local loopback
 * interface without a Clerk session (requirePlatformAdminOrLocalhost).
 * This script must run on the same host as the API server.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/refresh-all-sources.ts
 */

export {};

const port = process.env.PORT ?? "8080";
const BASE = `http://localhost:${port}/api`;
const HEADERS = { "Content-Type": "application/json" };

// CON-filings states to trigger individually
const CON_STATES = ["IL", "NY", "FL", "NC", "GA", "MI", "OH", "CT"] as const;

// All 15 free-API sources
const FREE_SOURCES = [
  "nppes", "fda_510k", "fda_recalls", "fda_maude", "fda_class",
  "propublica_990", "cms_data", "sec_edgar", "usa_spending",
  "sam_gov", "emma_bonds", "hcris", "hrsa", "usda", "medicare_util",
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunResult {
  source: string;
  status: "ok" | "error";
  /** HTTP status code */
  httpStatus?: number;
  /** Parsed JSON body (may contain nested error fields) */
  body?: Record<string, unknown>;
  /** Error message when status === "error" */
  errorMsg?: string;
  durationMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function post(label: string, path: string): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: HEADERS });
    const durationMs = Date.now() - t0;
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (!res.ok) {
      const msg = (body as { error?: string }).error ?? JSON.stringify(body).slice(0, 120);
      return { source: label, status: "error", httpStatus: res.status, errorMsg: msg, durationMs };
    }
    return { source: label, status: "ok", httpStatus: res.status, body, durationMs };
  } catch (err) {
    return { source: label, status: "error", errorMsg: String(err), durationMs: Date.now() - t0 };
  }
}

/** Extract signal count from a result body, regardless of nesting level. */
function countSignals(r: RunResult): number {
  if (!r.body) return 0;
  const b = r.body;
  if (typeof b.signalsInserted === "number") return b.signalsInserted;
  // free-apis wraps per-source: { nppes: { signalsInserted, errors } }
  return Object.values(b).reduce<number>((sum, v) => {
    if (v && typeof (v as Record<string, unknown>).signalsInserted === "number") {
      return sum + ((v as Record<string, unknown>).signalsInserted as number);
    }
    return sum;
  }, 0);
}

/**
 * Inspect a 200 body for internal per-source errors.
 * The free-apis endpoint returns { [source]: { error: "..." } } when a
 * source throws internally, even though the HTTP status is 200.
 */
function extractInternalErrors(r: RunResult): string[] {
  if (!r.body) return [];
  const errs: string[] = [];
  for (const [key, val] of Object.entries(r.body)) {
    if (val && typeof (val as Record<string, unknown>).error === "string") {
      errs.push(`${key}: ${(val as Record<string, unknown>).error as string}`);
    }
    if (val && typeof (val as Record<string, unknown>).errors === "number"
        && (val as Record<string, unknown>).errors as number > 0) {
      errs.push(`${key}: ${(val as Record<string, unknown>).errors as number} errors`);
    }
  }
  return errs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const wallStart = Date.now();
console.log("\n🔄  MedIntel OS — Refreshing all live data sources via API\n");

// ── Batch 1: CON Filings (per state) + Clinical Trials — parallel ─────────────
console.log(`Batch 1: CON Filings (${CON_STATES.join(", ")}) + Clinical Trials…`);
const [ct, ...conResults] = await Promise.all([
  post("Clinical Trials", "/signals/ingest/clinicaltrials"),
  ...CON_STATES.map((st) =>
    post(`CON Filings (${st})`, `/signals/ingest/con-filings?state=${st}`),
  ),
]);

// ── Batch 2: 15 free-API sources — parallel ────────────────────────────────────
console.log("Batch 2: 15 free-API sources in parallel…");
const freeResults = await Promise.all(
  FREE_SOURCES.map((src) =>
    post(src, `/signals/ingest/free-apis?source=${src}`),
  ),
);

// ── Batch 3: Score recompute ───────────────────────────────────────────────────
console.log("Batch 3: Recomputing signal scores…");
const scoreResult = await post("Signal Score Recompute", "/signals/recompute");

// ─── Report ───────────────────────────────────────────────────────────────────

const allResults: RunResult[] = [ct, ...conResults, ...freeResults, scoreResult];

const ok     = allResults.filter((r) => r.status === "ok");
const failed = allResults.filter((r) => r.status === "error");
const totalSignals = ok.reduce((n, r) => n + countSignals(r), 0);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  RESULTS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

for (const r of allResults) {
  const ms      = `(${(r.durationMs / 1000).toFixed(1)}s)`;
  const sigs    = countSignals(r);
  const sigStr  = sigs > 0 ? `  +${sigs} signals` : "";

  if (r.status === "error") {
    const code = r.httpStatus ? ` HTTP ${r.httpStatus}` : "";
    console.log(`❌  ${r.source}${code}  — ${r.errorMsg ?? "unknown error"}  ${ms}`);
    continue;
  }

  // Check for internal per-source errors inside a 200 body
  const internalErrs = extractInternalErrors(r);
  if (internalErrs.length > 0) {
    console.log(`⚠️   ${r.source}${sigStr}  — partial errors  ${ms}`);
    for (const e of internalErrs) console.log(`     • ${e}`);
  } else {
    console.log(`✅  ${r.source}${sigStr}  ${ms}`);
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  ${ok.length}/${allResults.length} sources returned HTTP 2xx`);
console.log(`  ~${totalSignals} total new signals inserted`);
if (failed.length > 0) {
  console.log(`  HTTP failures: ${failed.map((r) => r.source).join(", ")}`);
}
console.log(`  Total elapsed: ${((Date.now() - wallStart) / 1000).toFixed(1)}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

process.exit(failed.length > 0 ? 1 : 0);
