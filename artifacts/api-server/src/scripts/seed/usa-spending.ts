/**
 * USA Spending bulk seed — federal contract & grant awards filtered to
 * healthcare NAICS codes that produce hospital-relevant capex signals.
 *
 * USA Spending exposes a Bulk Download API:
 *   POST https://api.usaspending.gov/api/v2/bulk_download/awards/
 *   { "filters": {"agencies":[...], "naics_codes":[...], "date_type":"action_date",
 *                  "date_range":{"start_date":"2022-01-01","end_date":"2026-05-20"}},
 *     "file_format":"csv" }
 * The response includes a `file_url` and a `status_url` to poll. We poll
 * for completion (typical: 30s–10min for large extracts), then download
 * the ZIP, unpack the CSV, and stage rows into `usa_spending_raw`.
 *
 * The "healthcare capex" filter we apply at seed time:
 *   NAICS 622xxx (hospitals), 621xxx (ambulatory healthcare), 339112
 *   (surgical instrument manufacturing) — i.e. transactions where the
 *   recipient is a healthcare org or the contract is for medical equip.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/seed/usa-spending.ts \
 *     [--start-date 2022-01-01] [--end-date 2026-05-20] [--poll-interval-s 30]
 */

import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";
import { parse } from "csv-parse";
import { createReadStream } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger";
import {
  downloadFile,
  startSeedRun,
  finishSeedRun,
  withProgress,
  parseFlags,
  seedDataDir,
  ensureDir,
} from "./_lib";

const SOURCE_NAME = "usa_spending";
const BULK_URL = "https://api.usaspending.gov/api/v2/bulk_download/awards/";

const HEALTHCARE_NAICS = [
  "621",     // ambulatory healthcare (prefix match server-side)
  "622",     // hospitals
  "339112",  // surgical/medical instrument manufacturing
];

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function twoYearsAgoISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}
function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function runUsaSpendingSeed(opts: {
  startDate?: string;
  endDate?: string;
  pollIntervalS?: number;
  force?: boolean;
} = {}): Promise<{ rowsStaged: number; signalsInserted: number }> {
  const startDate = opts.startDate ?? twoYearsAgoISO();
  const endDate = opts.endDate ?? todayISO();
  const pollIntervalS = opts.pollIntervalS ?? 30;

  const runId = await startSeedRun({
    sourceName: SOURCE_NAME,
    fileUrl: BULK_URL,
    meta: { startDate, endDate, naics: HEALTHCARE_NAICS },
  });

  try {
    // 1. Kick off the bulk download.
    const body = {
      filters: {
        prime_award_types: ["A", "B", "C", "D"],
        date_type: "action_date",
        date_range: { start_date: startDate, end_date: endDate },
        naics_codes: { require: HEALTHCARE_NAICS, exclude: [] },
      },
      file_format: "csv",
    };
    logger.info({ body }, "usa-spending: submitting bulk download");
    const submitRes = await fetch(BULK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!submitRes.ok) {
      throw new Error(`USA Spending submit failed: ${submitRes.status}`);
    }
    const submitJson = (await submitRes.json()) as { file_url?: string; status_url?: string };
    if (!submitJson.file_url || !submitJson.status_url) {
      throw new Error("USA Spending submit response missing file_url/status_url");
    }

    // 2. Poll status_url until ready.
    let attempts = 0;
    while (attempts < 120) {
      // 120 * pollIntervalS seconds total — caller can shorten.
      const statusRes = await fetch(submitJson.status_url);
      const statusJson = (await statusRes.json()) as { status?: string };
      if (statusJson.status === "finished") break;
      if (statusJson.status === "failed") {
        throw new Error("USA Spending bulk job reported failed");
      }
      attempts++;
      await new Promise((r) => setTimeout(r, pollIntervalS * 1000));
    }

    // 3. Download the ZIP.
    const filename = path.basename(new URL(submitJson.file_url).pathname);
    const dl = await downloadFile({
      url: submitJson.file_url,
      subdir: "usa-spending",
      filename,
    });

    // 4. Unzip + stream CSV → staging.
    const unzipDir = await ensureDir(path.join(seedDataDir(), "usa-spending", "unzipped"));
    const directory = await unzipper.Open.file(dl.path);
    let rowsStaged = 0;
    for (const entry of directory.files) {
      if (!entry.path.endsWith(".csv")) continue;
      const dest = path.join(unzipDir, path.basename(entry.path));
      await new Promise<void>((resolve, reject) => {
        entry.stream().pipe(fs.createWriteStream(dest)).on("finish", () => resolve()).on("error", reject);
      });
      rowsStaged += await stageUsaSpendingCsv(dest);
    }

    const signalsInserted = await transformUsaSpending();
    // file_url isn't known until the bulk job finishes — patch it onto the
    // run row via the meta payload (finishSeedRun's signature only supports
    // updating status / counts / message).
    await finishSeedRun(runId, {
      status: "ok",
      rowsStaged,
      signalsInserted,
      meta: { file_url: submitJson.file_url, file_sha256: dl.sha256, file_bytes: dl.bytes },
    });
    return { rowsStaged, signalsInserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishSeedRun(runId, { status: "failed", errorMessage: msg });
    throw err;
  }
}

async function stageUsaSpendingCsv(csvPath: string): Promise<number> {
  return withProgress(`usa-spending:stage:${path.basename(csvPath)}`, async (tick) => {
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
        total += await flushUsaSpendingBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) total += await flushUsaSpendingBatch(batch);
    return total;
  });
}

async function flushUsaSpendingBatch(batch: Array<Record<string, string>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const piid =
      r.award_id_piid ??
      r.contract_award_unique_key ??
      r.assistance_award_unique_key ??
      r.generated_unique_award_id;
    if (!piid) continue;
    tuples.push(
      `(${lit(piid)}, ${lit(r.recipient_name)}, ${lit(r.recipient_uei)}, ` +
        `${lit(r.recipient_state_code ?? r.recipient_state)}, ${lit(r.recipient_zip_code ?? r.recipient_zip)}, ` +
        `${lit(num(r.total_obligated_amount ?? r.federal_action_obligation ?? r.award_amount))}, ` +
        `${lit(r.awarding_agency_name ?? r.awarding_agency)}, ${lit(r.awarding_sub_agency_name ?? r.awarding_subagency)}, ` +
        `${lit(r.product_or_service_code ?? r.psc)}, ${lit(r.naics_code)}, ` +
        `${lit(r.period_of_performance_start_date)}, ${lit(r.period_of_performance_current_end_date)}, ` +
        `${lit(r)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO usa_spending_raw (
      award_id_piid, recipient_name, recipient_uei, recipient_state_code, recipient_zip,
      award_amount, awarding_agency, awarding_subagency,
      product_or_service_code, naics_code,
      period_of_performance_start_date, period_of_performance_current_end_date,
      raw_json
    ) VALUES ${tuples.join(",")}
    ON CONFLICT (award_id_piid) DO UPDATE SET
      recipient_name        = EXCLUDED.recipient_name,
      recipient_uei         = EXCLUDED.recipient_uei,
      recipient_state_code  = EXCLUDED.recipient_state_code,
      recipient_zip         = EXCLUDED.recipient_zip,
      award_amount          = EXCLUDED.award_amount,
      awarding_agency       = EXCLUDED.awarding_agency,
      awarding_subagency    = EXCLUDED.awarding_subagency,
      product_or_service_code = EXCLUDED.product_or_service_code,
      naics_code            = EXCLUDED.naics_code,
      period_of_performance_start_date         = EXCLUDED.period_of_performance_start_date,
      period_of_performance_current_end_date   = EXCLUDED.period_of_performance_current_end_date,
      raw_json              = EXCLUDED.raw_json,
      ingested_at           = now()
  `));
  return tuples.length;
}

async function transformUsaSpending(): Promise<number> {
  // Healthcare capex → `aip_infra_spend` signal when the recipient name
  // token-overlaps a facility and the contract is for medical equipment
  // (NAICS 339112 or PSC starting with 65xx).
  const res = await db.execute<{ id: string }>(sql`
    WITH cand AS (
      SELECT u.award_id_piid, u.recipient_name, u.recipient_state_code,
             u.award_amount, u.awarding_agency, u.naics_code,
             u.product_or_service_code, u.period_of_performance_start_date,
             'usa_spending:' || u.award_id_piid AS sval
        FROM usa_spending_raw u
       WHERE u.award_amount IS NOT NULL
         AND u.award_amount >= 100000
         AND (
           u.naics_code = '339112'
           OR LEFT(u.product_or_service_code, 2) = '65'
           OR LEFT(u.naics_code, 3) = '622'
         )
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, confidence, source, metadata, is_active
    )
    SELECT f.id,
           'aip_infra_spend'::signal_type,
           c.sval,
           60,
           'usa_spending',
           jsonb_build_object(
             'award_id', c.award_id_piid,
             'recipient_name', c.recipient_name,
             'award_amount', c.award_amount,
             'awarding_agency', c.awarding_agency,
             'naics_code', c.naics_code,
             'psc', c.product_or_service_code,
             'pop_start', c.period_of_performance_start_date
           ),
           true
      FROM cand c
      JOIN facilities f
        ON (f.state IS NULL OR c.recipient_state_code IS NULL OR f.state = c.recipient_state_code)
       AND f.name % c.recipient_name
     WHERE NOT EXISTS (
       SELECT 1 FROM purchase_signals ps
        WHERE ps.facility_id = f.id
          AND ps.signal_type = 'aip_infra_spend'
          AND ps.signal_value = c.sval
     )
    RETURNING id
  `);
  return res.rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  runUsaSpendingSeed({
    startDate: typeof flags["start-date"] === "string" ? flags["start-date"] : undefined,
    endDate: typeof flags["end-date"] === "string" ? flags["end-date"] : undefined,
    pollIntervalS:
      typeof flags["poll-interval-s"] === "string" ? Number(flags["poll-interval-s"]) : undefined,
    force: flags.force === true,
  })
    .then((r) => {
      logger.info(r, "usa-spending: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "usa-spending: seed failed");
      process.exit(1);
    });
}
