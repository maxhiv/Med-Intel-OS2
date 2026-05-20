/**
 * NIH RePORTER bulk seed — annual CSV exports of all NIH-funded projects.
 *
 * NIH ExPORTER publishes one CSV per fiscal year:
 *   https://reporter.nih.gov/exporter/projects/download/<FY>
 * Each CSV has the same column layout. We default to seeding the most
 * recent 5 fiscal years; the orchestrator can pass --years to override.
 *
 * Stages into `nih_grants_raw`. Emits `nih_grant` and `grant_awarded`
 * signals when the awarded organization name fuzzy-matches a facility.
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

const SOURCE_NAME = "nih_grants";
const URL_FOR_FY = (fy: number) => `https://reporter.nih.gov/exporter/projects/download/${fy}`;

function defaultYears(): number[] {
  const thisFy = new Date().getFullYear();
  // FY runs Oct→Sep, but the ExPORTER files are released after fiscal year
  // close. Keep the last 5 closed years.
  return [thisFy - 1, thisFy - 2, thisFy - 3, thisFy - 4, thisFy - 5];
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function dt(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function runNihGrantsSeed(opts: {
  years?: number[];
  force?: boolean;
} = {}): Promise<{ rowsStaged: number; signalsInserted: number }> {
  const years = opts.years ?? defaultYears();
  let totalStaged = 0;

  for (const fy of years) {
    const url = URL_FOR_FY(fy);
    const filename = `NIH_Projects_FY${fy}.csv`;
    const dl = await downloadFile({ url, subdir: "nih-grants", filename });
    if (!opts.force && (await hasSuccessfulSeed(SOURCE_NAME, dl.sha256))) {
      logger.info({ fy, sha256: dl.sha256 }, "nih-grants: cached, skipping");
      continue;
    }
    const runId = await startSeedRun({
      sourceName: SOURCE_NAME,
      fileUrl: url,
      fileSha256: dl.sha256,
      fileBytes: dl.bytes,
      meta: { fy },
    });
    try {
      const rowsStaged = await stageNihCsv(dl.path);
      totalStaged += rowsStaged;
      await finishSeedRun(runId, { status: "ok", rowsStaged, meta: { fy } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishSeedRun(runId, { status: "failed", errorMessage: msg, meta: { fy } });
      throw err;
    }
  }

  const signalsInserted = await transformNih();
  return { rowsStaged: totalStaged, signalsInserted };
}

async function stageNihCsv(csvPath: string): Promise<number> {
  return withProgress(`nih-grants:stage:${path.basename(csvPath)}`, async (tick) => {
    const parser = createReadStream(csvPath).pipe(
      parse({ columns: true, skip_empty_lines: true, trim: true, relax_quotes: true }),
    );
    const BATCH = 500;
    let batch: Array<Record<string, string>> = [];
    let total = 0;
    for await (const rec of parser as AsyncIterable<Record<string, string>>) {
      batch.push(rec);
      tick();
      if (batch.length >= BATCH) {
        total += await flushNihBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) total += await flushNihBatch(batch);
    return total;
  });
}

async function flushNihBatch(batch: Array<Record<string, string>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const applId = r.APPLICATION_ID ?? r.appl_id;
    if (!applId) continue;
    tuples.push(
      `(${Number(applId)}, ${lit(r.PROJECT_NUMBER ?? r.project_num)}, ` +
        `${lit(Number(r.FY ?? r.fiscal_year) || null)}, ${lit(num(r.TOTAL_COST ?? r.award_amount))}, ` +
        `${lit(r.ORG_NAME ?? r.org_name)}, ${lit(r.ORG_CITY ?? r.org_city)}, ` +
        `${lit(r.ORG_STATE ?? r.org_state)}, ${lit(r.ORG_ZIPCODE ?? r.org_zip)}, ` +
        `${lit(r.PI_NAMEs ?? r.PI_NAME ?? r.pi_name)}, ${lit(r.PI_EMAILS ?? r.pi_email)}, ` +
        `${lit(r.PROJECT_TITLE ?? r.project_title)}, ` +
        `${lit(dt(r.PROJECT_START ?? r.project_start_date))}, ${lit(dt(r.PROJECT_END ?? r.project_end_date))}, ` +
        `${lit(dt(r.AWARD_NOTICE_DATE ?? r.award_notice_date))}, ${lit(r)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO nih_grants_raw (
      appl_id, project_num, fiscal_year, award_amount,
      org_name, org_city, org_state, org_zip,
      pi_name, pi_email, project_title,
      project_start_date, project_end_date, award_notice_date,
      raw_json
    ) VALUES ${tuples.join(",")}
    ON CONFLICT (appl_id) DO UPDATE SET
      project_num        = EXCLUDED.project_num,
      fiscal_year        = EXCLUDED.fiscal_year,
      award_amount       = EXCLUDED.award_amount,
      org_name           = EXCLUDED.org_name,
      org_city           = EXCLUDED.org_city,
      org_state          = EXCLUDED.org_state,
      org_zip            = EXCLUDED.org_zip,
      pi_name            = EXCLUDED.pi_name,
      pi_email           = EXCLUDED.pi_email,
      project_title      = EXCLUDED.project_title,
      project_start_date = EXCLUDED.project_start_date,
      project_end_date   = EXCLUDED.project_end_date,
      award_notice_date  = EXCLUDED.award_notice_date,
      raw_json           = EXCLUDED.raw_json,
      ingested_at        = now()
  `));
  return tuples.length;
}

async function transformNih(): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    WITH cand AS (
      SELECT g.appl_id, g.fiscal_year, g.project_num, g.award_amount,
             g.pi_name, g.project_title, g.org_state, g.org_name,
             g.award_notice_date, g.project_start_date,
             'nih:' || g.appl_id::text AS sval
        FROM nih_grants_raw g
       WHERE g.award_amount IS NOT NULL
         AND g.award_amount >= 250000          -- ignore micro-grants
         AND COALESCE(g.award_notice_date, g.project_start_date) > now() - interval '36 months'
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, confidence, source, metadata, is_active
    )
    SELECT f.id,
           'nih_grant'::signal_type,
           c.sval,
           70,
           'nih_reporter',
           jsonb_build_object(
             'appl_id', c.appl_id,
             'fy', c.fiscal_year,
             'project_num', c.project_num,
             'award_amount', c.award_amount,
             'pi_name', c.pi_name,
             'project_title', c.project_title,
             'award_notice_date', c.award_notice_date
           ),
           true
      FROM cand c
      JOIN facilities f
        ON (f.state IS NULL OR c.org_state IS NULL OR f.state = c.org_state)
       AND f.name % c.org_name
     WHERE NOT EXISTS (
       SELECT 1 FROM purchase_signals ps
        WHERE ps.facility_id = f.id
          AND ps.signal_type = 'nih_grant'
          AND ps.signal_value = c.sval
     )
    RETURNING id
  `);
  return res.rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  const years =
    typeof flags.years === "string"
      ? flags.years.split(",").map((y) => Number(y.trim())).filter((y) => Number.isFinite(y))
      : undefined;
  runNihGrantsSeed({ years, force: flags.force === true })
    .then((r) => {
      logger.info(r, "nih-grants: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "nih-grants: seed failed");
      process.exit(1);
    });
}
