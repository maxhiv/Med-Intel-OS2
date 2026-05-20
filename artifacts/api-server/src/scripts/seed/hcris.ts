/**
 * HCRIS bulk seed — Hospital Provider Cost Report (CMS).
 *
 * Data source:
 *   https://data.cms.gov/provider-compliance/cost-report/hospital-provider-cost-report
 *   Bulk CSV downloads under "Data" → "API/CSV" panel. CMS publishes one CSV
 *   per fiscal year ending in -hospital_provider_cost_report.csv.
 *
 *   The dataset distribution URL pattern (resolved via the dataset's metadata
 *   API) is the stable handle. We default to the latest released year and
 *   accept --url <override> for operators who want a specific year.
 *
 * Stages into `hcris_raw`, then:
 *   1. Updates facilities.beds + facilities.{net_pat_rev, depreciation, …}
 *      via the existing /facilities columns where they're already wired.
 *   2. Computes the `hcris_depreciation_spike` signal (delta vs prior year >
 *      thresh) and inserts into `purchase_signals`.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/seed/hcris.ts
 *   Optional flags:
 *     --url https://...        Override the bulk CSV URL.
 *     --limit 1000             Stop after N rows (test mode).
 *     --force                  Re-run even if sha256 matches a prior 'ok' run.
 */

import { createReadStream } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger";
import {
  downloadFile,
  startSeedRun,
  finishSeedRun,
  hasSuccessfulSeed,
  withProgress,
  parseFlags,
} from "./_lib";

// CMS Hospital Provider Cost Report — latest annual file. Operator can
// override via --url if a newer release lands.
const DEFAULT_URL =
  "https://data.cms.gov/sites/default/files/2024-09/Hospital_Provider_Cost_Report.csv";
const SOURCE_NAME = "hcris";
const SPIKE_PCT = 0.25; // 25% YoY depreciation jump → emit spike signal

function num(v: string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function dt(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface HcrisRow {
  RPT_REC_NUM?: string;
  PROVIDER_CCN?: string;
  PROVIDER_NUMBER?: string;     // alternate column name in some releases
  CCN?: string;
  FY_BGN_DT?: string;
  FY_END_DT?: string;
  TOTAL_BEDS?: string;
  NUMBER_OF_BEDS?: string;
  NET_PAT_REV?: string;
  TOTAL_COSTS?: string;
  NET_INCOME?: string;
  TOTAL_ASSETS?: string;
  TOTAL_LIABILITIES?: string;
  TOTAL_EQUITY?: string;
  FIXED_ASSETS?: string;
  DEPRECIATION?: string;
  TOTAL_SALARIES?: string;
  CONTRACT_LABOR?: string;
}

export async function runHcrisSeed(opts: {
  url?: string;
  limit?: number;
  force?: boolean;
} = {}): Promise<{ rowsStaged: number; rowsUpserted: number; signalsInserted: number }> {
  const url = opts.url ?? DEFAULT_URL;
  const filename = path.basename(new URL(url).pathname) || "hcris.csv";

  // Download (or reuse cached).
  const dl = await downloadFile({
    url,
    subdir: "hcris",
    filename,
  });

  // Skip if we've already seeded this exact file successfully.
  if (!opts.force && (await hasSuccessfulSeed(SOURCE_NAME, dl.sha256))) {
    logger.info(
      { sha256: dl.sha256 },
      "hcris: file already seeded successfully, skipping (pass --force to override)",
    );
    return { rowsStaged: 0, rowsUpserted: 0, signalsInserted: 0 };
  }

  const runId = await startSeedRun({
    sourceName: SOURCE_NAME,
    fileUrl: url,
    fileSha256: dl.sha256,
    fileBytes: dl.bytes,
  });

  try {
    // Stage into hcris_raw.
    const rowsStaged = await stageHcris(dl.path, opts.limit ?? 0);

    // Transform: update facilities + emit depreciation spike signals.
    const { facilitiesUpdated, signalsInserted } = await transformHcris();

    await finishSeedRun(runId, {
      status: "ok",
      rowsStaged,
      rowsUpserted: facilitiesUpdated,
      signalsInserted,
    });

    return { rowsStaged, rowsUpserted: facilitiesUpdated, signalsInserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishSeedRun(runId, { status: "failed", errorMessage: msg });
    throw err;
  }
}

async function stageHcris(csvPath: string, limit: number): Promise<number> {
  return withProgress("hcris:stage", async (tick) => {
    // Truncate then bulk insert — staging is throwaway.
    await db.execute(sql`TRUNCATE TABLE hcris_raw`);

    const parser = createReadStream(csvPath).pipe(
      parse({ columns: true, skip_empty_lines: true, trim: true, relax_quotes: true }),
    );

    const BATCH = 500;
    let batch: HcrisRow[] = [];
    let total = 0;

    for await (const rec of parser as AsyncIterable<HcrisRow>) {
      batch.push(rec);
      tick();
      if (batch.length >= BATCH) {
        await flushHcrisBatch(batch, csvPath);
        total += batch.length;
        batch = [];
        if (limit > 0 && total >= limit) break;
      }
    }
    if (batch.length > 0) {
      await flushHcrisBatch(batch, csvPath);
      total += batch.length;
    }
    return total;
  });
}

// Local SQL-literal escaper for the inline multi-row INSERT. Same shape as
// the IRS 990 runner — staging tables aren't in the Drizzle schema so we
// can't use the typed insert builder, and we want one large statement per
// batch rather than 500 round-trips.
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function flushHcrisBatch(batch: HcrisRow[], srcFile: string) {
  const tuples: string[] = [];
  for (const r of batch) {
    const ccn = (r.PROVIDER_CCN ?? r.PROVIDER_NUMBER ?? r.CCN ?? "").trim();
    if (!ccn) continue;
    const fyEnd = dt(r.FY_END_DT);
    if (!fyEnd) continue;
    tuples.push(
      `(${lit(r.RPT_REC_NUM ? Number(r.RPT_REC_NUM) : null)},` +
        `${lit(ccn)},` +
        `${lit(dt(r.FY_BGN_DT))},` +
        `${lit(fyEnd)},` +
        `${lit(num(r.TOTAL_BEDS ?? r.NUMBER_OF_BEDS))},` +
        `${lit(num(r.NET_PAT_REV))},` +
        `${lit(num(r.TOTAL_COSTS))},` +
        `${lit(num(r.NET_INCOME))},` +
        `${lit(num(r.TOTAL_ASSETS))},` +
        `${lit(num(r.TOTAL_LIABILITIES))},` +
        `${lit(num(r.TOTAL_EQUITY))},` +
        `${lit(num(r.FIXED_ASSETS))},` +
        `${lit(num(r.DEPRECIATION))},` +
        `${lit(num(r.TOTAL_SALARIES))},` +
        `${lit(num(r.CONTRACT_LABOR))},` +
        `${lit(path.basename(srcFile))},` +
        `now())`,
    );
  }
  if (tuples.length === 0) return;

  await db.execute(sql.raw(`
    INSERT INTO hcris_raw (
      rpt_rec_num, provider_ccn, fy_bgn_dt, fy_end_dt,
      total_beds, net_pat_rev, total_costs, net_income,
      total_assets, total_liabilities, total_equity,
      fixed_assets, depreciation, total_salaries, contract_labor,
      source_file, ingested_at
    ) VALUES ${tuples.join(",")}
    ON CONFLICT (provider_ccn, fy_end_dt) DO UPDATE SET
      rpt_rec_num       = EXCLUDED.rpt_rec_num,
      fy_bgn_dt         = EXCLUDED.fy_bgn_dt,
      total_beds        = EXCLUDED.total_beds,
      net_pat_rev       = EXCLUDED.net_pat_rev,
      total_costs       = EXCLUDED.total_costs,
      net_income        = EXCLUDED.net_income,
      total_assets      = EXCLUDED.total_assets,
      total_liabilities = EXCLUDED.total_liabilities,
      total_equity      = EXCLUDED.total_equity,
      fixed_assets      = EXCLUDED.fixed_assets,
      depreciation      = EXCLUDED.depreciation,
      total_salaries    = EXCLUDED.total_salaries,
      contract_labor    = EXCLUDED.contract_labor,
      source_file       = EXCLUDED.source_file,
      ingested_at       = EXCLUDED.ingested_at
  `));
}

async function transformHcris(): Promise<{ facilitiesUpdated: number; signalsInserted: number }> {
  // 1. Update facilities.beds from the most recent HCRIS row per CCN.
  const updated = await db.execute<{ count: string }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (provider_ccn)
             provider_ccn, total_beds
        FROM hcris_raw
       WHERE total_beds IS NOT NULL
       ORDER BY provider_ccn, fy_end_dt DESC
    )
    UPDATE facilities f
       SET beds = latest.total_beds
      FROM latest
     WHERE f.cms_id = latest.provider_ccn
       AND (f.beds IS NULL OR f.beds <> latest.total_beds)
    RETURNING f.id
  `);

  // 2. Depreciation spike: latest depreciation > (1 + SPIKE_PCT) × prior year.
  //    Emits hcris_depreciation_spike signals into purchase_signals. Dedup is
  //    via NOT EXISTS — purchase_signals has no unique constraint on
  //    (facility_id, signal_type, signal_value); the live ingestors do the
  //    same client-side filter.
  const sig = await db.execute<{ id: string }>(sql`
    WITH ranked AS (
      SELECT provider_ccn, fy_end_dt, depreciation,
             LAG(depreciation) OVER (PARTITION BY provider_ccn ORDER BY fy_end_dt) AS prior_dep
        FROM hcris_raw
       WHERE depreciation IS NOT NULL
    ),
    spikes AS (
      SELECT provider_ccn, fy_end_dt, depreciation, prior_dep,
             'hcris:' || provider_ccn || ':' || EXTRACT(YEAR FROM fy_end_dt)::text AS sval
        FROM ranked
       WHERE prior_dep IS NOT NULL
         AND prior_dep > 0
         AND depreciation > prior_dep * ${1 + SPIKE_PCT}
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, confidence, source, metadata, is_active
    )
    SELECT f.id,
           'hcris_depreciation_spike'::signal_type,
           s.sval,
           75,
           'hcris',
           jsonb_build_object(
             'fy_end_dt', s.fy_end_dt,
             'depreciation', s.depreciation,
             'prior_year_depreciation', s.prior_dep,
             'yoy_pct', ROUND(((s.depreciation - s.prior_dep) / s.prior_dep)::numeric, 4)
           ),
           true
      FROM spikes s
      JOIN facilities f ON f.cms_id = s.provider_ccn
     WHERE NOT EXISTS (
       SELECT 1 FROM purchase_signals ps
        WHERE ps.facility_id = f.id
          AND ps.signal_type = 'hcris_depreciation_spike'
          AND ps.signal_value = s.sval
     )
    RETURNING id
  `);

  return {
    facilitiesUpdated: updated.rows.length,
    signalsInserted: sig.rows.length,
  };
}

// ─── CLI entry ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  const url = typeof flags.url === "string" ? flags.url : undefined;
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 0;
  const force = flags.force === true;

  runHcrisSeed({ url, limit, force })
    .then((r) => {
      logger.info(r, "hcris: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "hcris: seed failed");
      process.exit(1);
    });
}
