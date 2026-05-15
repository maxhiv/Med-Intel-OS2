/**
 * Continuous bulk ingestor — loops the /signals/ingest/bulk endpoint for
 * target states until every facility has been scraped at least once.
 *
 * Designed for filling a fresh database with IL + TX signals before lead
 * qualification begins.  Run it, let it churn, and stop it once the
 * coverage table shows 100 % for both states.
 *
 * Auth: uses INTERNAL_ADMIN_KEY (Replit Secret) — must be set before running.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run bulk-ingest
 *
 * Environment overrides:
 *   INGEST_STATES         Comma-sep state codes  (default: IL,TX)
 *   INGEST_LIMIT          Facilities per source   (default: 500)
 *   INGEST_ROUND_PAUSE_MS Pause between rounds    (default: 15000)
 */

export {};

// ─── Config ───────────────────────────────────────────────────────────────────

const STATES = (process.env.INGEST_STATES ?? "IL,TX")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const LIMIT            = Math.max(1, Math.min(Number(process.env.INGEST_LIMIT ?? 500), 2000));
const ROUND_PAUSE_MS   = Math.max(5000, Number(process.env.INGEST_ROUND_PAUSE_MS ?? 15_000));

// ─── Validate env ─────────────────────────────────────────────────────────────

const internalKey = process.env.INTERNAL_ADMIN_KEY;
if (!internalKey) {
  console.error(
    "ERROR: INTERNAL_ADMIN_KEY secret is not set.\n" +
    "Add it in the Replit Secrets panel, then restart and re-run.",
  );
  process.exit(1);
}

const port = process.env.PORT ?? "8080";
const bulkUrl     = `http://localhost:${port}/api/signals/ingest/bulk`;
const coverageUrl = `http://localhost:${port}/api/admin/signal-coverage`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SourceResult {
  status: "ok" | "error";
  signalsInserted: number;
  facilitiesUpdated: number;
  errors: number;
  errorMsg?: string;
  durationMs: number;
}

interface BulkResponse {
  states: string[];
  limitPerSource: number;
  totalSignals: number;
  totalFacilitiesUpdated: number;
  totalErrors: number;
  sources: Record<string, SourceResult>;
}

interface CoverageRow {
  state: string;
  total: number;
  scraped: number;
  withSignals: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function pct(num: number, den: number) {
  if (den === 0) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function bar(num: number, den: number, width = 20) {
  if (den === 0) return "[" + " ".repeat(width) + "]";
  const filled = Math.round((num / den) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

// ─── Coverage check via DB (direct query through the API) ────────────────────

async function fetchCoverage(): Promise<CoverageRow[] | null> {
  try {
    const res = await fetch(coverageUrl, {
      headers: {
        "x-internal-admin-key": internalKey!,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const json = await res.json() as { coverage?: CoverageRow[] };
    return json.coverage ?? null;
  } catch {
    return null;
  }
}

function printCoverage(rows: CoverageRow[]) {
  const targeted = rows.filter((r) => STATES.includes(r.state));
  if (targeted.length === 0) return;
  console.log("\n  State   Total       Scraped        Signals");
  console.log("  ─────────────────────────────────────────────────────");
  for (const r of targeted) {
    const scrapedBar = bar(r.scraped, r.total);
    const scrapedPct = pct(r.scraped, r.total);
    const sigPct     = pct(r.withSignals, r.total);
    console.log(
      `  ${r.state.padEnd(6)} ${fmt(r.total).padStart(7)}   ` +
      `${scrapedBar} ${scrapedPct.padStart(6)}   signals: ${sigPct.padStart(6)} (${fmt(r.withSignals)})`,
    );
  }
}

function allScraped(rows: CoverageRow[]) {
  const targeted = rows.filter((r) => STATES.includes(r.state));
  return (
    targeted.length === STATES.length &&
    targeted.every((r) => r.scraped >= r.total && r.total > 0)
  );
}

// ─── One ingestion round ──────────────────────────────────────────────────────

async function runRound(round: number): Promise<BulkResponse | null> {
  console.log(`\n  Round ${round} — ingesting ${STATES.join(" + ")} (limit ${fmt(LIMIT)}/source)`);
  const t0 = Date.now();
  try {
    const res = await fetch(bulkUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-admin-key": internalKey!,
      },
      body: JSON.stringify({ states: STATES, limitPerSource: LIMIT, recomputeScores: false }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`  HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = await res.json() as BulkResponse;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s — +${fmt(json.totalSignals)} signals, ${fmt(json.totalFacilitiesUpdated)} facilities touched`);

    // Print per-source breakdown
    const maxName = Math.max(...Object.keys(json.sources).map((n) => n.length));
    for (const [name, r] of Object.entries(json.sources)) {
      if (name === "score_recompute") continue;
      const icon  = r.status === "ok" ? "  OK" : " ERR";
      const sigs  = r.signalsInserted > 0 ? `+${fmt(r.signalsInserted)} sigs`.padStart(14) : "             ";
      const upd   = r.facilitiesUpdated > 0 ? `${fmt(r.facilitiesUpdated)} fac`.padStart(10) : "         ";
      const errs  = r.errors > 0 ? `  ${r.errors} err` : "";
      const ms    = `${(r.durationMs / 1000).toFixed(1)}s`.padStart(7);
      console.log(`  ${icon}  ${name.padEnd(maxName)}  ${sigs}  ${upd} ${ms}${errs}`);
    }

    return json;
  } catch (err) {
    console.error(`  Failed to reach API server: ${String(err)}`);
    return null;
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log("  MedIntel OS — Continuous Bulk Ingestor");
console.log(`  Target states : ${STATES.join(", ")}`);
console.log(`  Limit/source  : ${fmt(LIMIT)} facilities per round`);
console.log(`  Round pause   : ${(ROUND_PAUSE_MS / 1000).toFixed(0)}s`);
console.log(`  Endpoint      : ${bulkUrl}`);
console.log("═".repeat(70));

// Wait for the API server to be ready (up to 30s)
console.log("\nWaiting for API server to be ready...");
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const probe = await fetch(`http://localhost:${port}/api/health`);
    if (probe.ok) { console.log("  API server is up.\n"); break; }
  } catch { /* not ready yet */ }
  if (attempt === 29) {
    console.error("API server did not become ready in 30s. Exiting.");
    process.exit(1);
  }
  await sleep(1000);
}

let round = 0;
let totalSignals = 0;
let totalFacilities = 0;
let consecutiveNulls = 0;

while (true) {
  round++;

  // Coverage report
  const coverage = await fetchCoverage();
  if (coverage) {
    printCoverage(coverage);
    if (allScraped(coverage)) {
      console.log("\n" + "═".repeat(70));
      console.log("  ALL FACILITIES SCRAPED — Database is fully populated!");
      console.log(`  ${fmt(totalSignals)} total signals inserted across ${round - 1} rounds.`);
      console.log("═".repeat(70) + "\n");
      process.exit(0);
    }
  } else {
    console.log("  (coverage endpoint unavailable — continuing)");
  }

  // Run the round
  const result = await runRound(round);

  if (result) {
    totalSignals    += result.totalSignals;
    totalFacilities += result.totalFacilitiesUpdated;
    consecutiveNulls = 0;
  } else {
    consecutiveNulls++;
    if (consecutiveNulls >= 5) {
      console.error("\nAPI server unreachable 5 rounds in a row — giving up.");
      process.exit(1);
    }
    console.log(`  Retrying in ${(ROUND_PAUSE_MS / 1000).toFixed(0)}s...`);
  }

  console.log(`\n  Cumulative: ${fmt(totalSignals)} signals, ${fmt(totalFacilities)} facility-touches across ${round} rounds.`);
  console.log(`  Pausing ${(ROUND_PAUSE_MS / 1000).toFixed(0)}s before next round...`);

  await sleep(ROUND_PAUSE_MS);
}
