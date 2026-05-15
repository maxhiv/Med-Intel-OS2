/**
 * Continuous bulk ingestor — calls ingestors directly (no HTTP) so there is
 * no request-timeout ceiling.  Loops until every IL+TX facility has been
 * scraped at least once, then exits cleanly.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run bulk-ingest
 *
 * Environment overrides:
 *   INGEST_STATES         Comma-sep state codes  (default: IL,TX)
 *   INGEST_LIMIT          Facilities per source   (default: 500)
 *   INGEST_ROUND_PAUSE_MS Pause between rounds    (default: 10000)
 */

export {};

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { recomputeAllScores } from "../services/signalScorer";
import { ingestFdaClassification } from "../services/fdaClassificationIngestor";
import { ingestNppes }             from "../services/nppesIngestor";
import { ingestCmsData }           from "../services/cmsDataIngestor";
import { ingestUsaSpending }       from "../services/usaSpendingIngestor";
import { ingestClinicalTrials }    from "../services/clinicalTrialsIngestor";
import { ingestSecEdgar }          from "../services/secEdgarIngestor";
import { ingestPropublica990 }     from "../services/propublica990Ingestor";
import { ingestHrsa }              from "../services/hrsaIngestor";
import { ingestUsda }              from "../services/usdaIngestor";

// ─── Config ───────────────────────────────────────────────────────────────────

const STATES = (process.env.INGEST_STATES ?? "IL,TX")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const LIMIT          = Math.max(1, Math.min(Number(process.env.INGEST_LIMIT ?? 500), 2000));
const ROUND_PAUSE_MS = Math.max(5_000, Number(process.env.INGEST_ROUND_PAUSE_MS ?? 10_000));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fmt(n: number) { return n.toLocaleString("en-US"); }
function pct(num: number, den: number) {
  return den === 0 ? "—" : `${((num / den) * 100).toFixed(1)}%`;
}
function bar(num: number, den: number, width = 20) {
  if (den === 0) return "[" + " ".repeat(width) + "]";
  const filled = Math.round((num / den) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

// ─── Coverage query ───────────────────────────────────────────────────────────

interface CoverageRow { state: string; total: number; scraped: number; withSignals: number }

async function getCoverage(): Promise<CoverageRow[]> {
  const stateList = STATES.map((s) => `'${s}'`).join(",");
  const result = await db.execute<{
    state: string; total: string; scraped: string; with_signals: string;
  }>(sql.raw(`
    SELECT
      f.state,
      COUNT(*)::int                                               AS total,
      COUNT(*) FILTER (WHERE f.last_scraped_at IS NOT NULL)::int AS scraped,
      COUNT(DISTINCT ps.facility_id)::int                        AS with_signals
    FROM facilities f
    LEFT JOIN purchase_signals ps ON ps.facility_id = f.id AND ps.is_active = true
    WHERE f.state IN (${stateList})
    GROUP BY f.state
    ORDER BY f.state
  `));
  return (result.rows as { state: string; total: string; scraped: string; with_signals: string }[]).map((r) => ({
    state: r.state,
    total: Number(r.total),
    scraped: Number(r.scraped),
    withSignals: Number(r.with_signals),
  }));
}

function printCoverage(rows: CoverageRow[]) {
  console.log("\n  State   Total      Scraped                       Signals");
  console.log("  ──────────────────────────────────────────────────────────");
  for (const r of rows) {
    console.log(
      `  ${r.state.padEnd(6)} ${fmt(r.total).padStart(7)}  ` +
      `${bar(r.scraped, r.total)} ${pct(r.scraped, r.total).padStart(6)}  ` +
      `signals: ${pct(r.withSignals, r.total).padStart(6)} (${fmt(r.withSignals)})`,
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

// ─── One round ────────────────────────────────────────────────────────────────

interface RunResult { name: string; signals: number; facilities: number; errors: number; ms: number }

async function runOne(
  name: string,
  fn: () => Promise<{ signalsInserted: number; errors: number; facilitiesScanned?: number }>,
): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { name, signals: r.signalsInserted, facilities: r.facilitiesScanned ?? 0, errors: r.errors, ms: Date.now() - t0 };
  } catch (err) {
    console.error(`  [${name}] threw: ${String(err).slice(0, 120)}`);
    return { name, signals: 0, facilities: 0, errors: 1, ms: Date.now() - t0 };
  }
}

async function runRound(round: number): Promise<{ signals: number; facilities: number }> {
  console.log(`\n  ── Round ${round} ──────────────────────────────────────────────`);

  const opts = { limit: LIMIT, states: STATES };

  // Batch A: parallel (fast / no per-facility HTTP)
  const batchA = await Promise.all([
    runOne("fda_class",   () => ingestFdaClassification(opts)),
    runOne("nppes",       () => ingestNppes(opts)),
  ]);

  // Batch B: parallel (moderate rate)
  const batchB = await Promise.all([
    runOne("cms_data",      () => ingestCmsData(opts)),
    runOne("usa_spending",  () => ingestUsaSpending(opts)),
    runOne("clinical_trials", () => ingestClinicalTrials(opts)),
    runOne("sec_edgar",     () => ingestSecEdgar(opts)),
  ]);

  // Batch C: sequential (rate-sensitive)
  const batchC: RunResult[] = [];
  batchC.push(await runOne("propublica_990", () => ingestPropublica990(opts)));
  batchC.push(await runOne("hrsa",           () => ingestHrsa(opts)));
  batchC.push(await runOne("usda",           () => ingestUsda(opts)));

  const all = [...batchA, ...batchB, ...batchC];

  // Print per-source table
  const maxName = Math.max(...all.map((r) => r.name.length));
  for (const r of all) {
    const icon = r.errors > 0 ? " ERR" : "  OK";
    const sigs = r.signals > 0  ? `+${fmt(r.signals)} sigs`.padStart(14) : "".padStart(14);
    const fac  = r.facilities > 0 ? `${fmt(r.facilities)} fac`.padStart(10) : "".padStart(10);
    const errs = r.errors > 0  ? `  ${r.errors} err` : "";
    const ms   = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(`  ${icon}  ${r.name.padEnd(maxName)}  ${sigs}  ${fac} ${ms}${errs}`);
  }

  const totalSignals    = all.reduce((s, r) => s + r.signals, 0);
  const totalFacilities = all.reduce((s, r) => s + r.facilities, 0);
  console.log(`\n  Round ${round} done — +${fmt(totalSignals)} signals, ${fmt(totalFacilities)} facilities touched`);
  return { signals: totalSignals, facilities: totalFacilities };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(68));
console.log("  MedIntel OS — Continuous Bulk Ingestor");
console.log(`  States        : ${STATES.join(", ")}`);
console.log(`  Limit/source  : ${fmt(LIMIT)} facilities per round`);
console.log(`  Round pause   : ${(ROUND_PAUSE_MS / 1000).toFixed(0)}s`);
console.log("═".repeat(68));

// Confirm DB is reachable before starting
try {
  await db.execute(sql`SELECT 1`);
  console.log("\n  DB connected.\n");
} catch (err) {
  console.error("DB connection failed:", String(err));
  process.exit(1);
}

let round = 0;
let cumSignals = 0;
let cumFacilities = 0;

while (true) {
  round++;

  // Coverage snapshot
  let coverage: CoverageRow[] = [];
  try {
    coverage = await getCoverage();
    printCoverage(coverage);
  } catch (err) {
    console.warn("  Coverage query failed:", String(err));
  }

  if (coverage.length > 0 && allScraped(coverage)) {
    console.log("\n" + "═".repeat(68));
    console.log("  ALL FACILITIES SCRAPED — recomputing scores...");
    await recomputeAllScores();
    console.log(`  Done. ${fmt(cumSignals)} total signals across ${round - 1} rounds.`);
    console.log("═".repeat(68) + "\n");
    process.exit(0);
  }

  const { signals, facilities } = await runRound(round);
  cumSignals    += signals;
  cumFacilities += facilities;

  console.log(`\n  Cumulative: ${fmt(cumSignals)} signals, ${fmt(cumFacilities)} facility-touches, ${round} rounds`);
  console.log(`  Pausing ${(ROUND_PAUSE_MS / 1000).toFixed(0)}s...\n`);
  await sleep(ROUND_PAUSE_MS);
}
