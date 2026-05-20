/**
 * Medicare Physician/Supplier Utilization seed.
 *
 * CMS publishes an annual file: Medicare Physician & Other Practitioners
 * by Provider and Service. The exact URL changes each release; latest
 * known pattern:
 *
 *   https://data.cms.gov/sites/default/files/<YYYY>-MM/MUP_PHY_R<rev>_P<part>_V<v>_D<dataset>_Prov.csv
 *
 * Operators should pass --url <override> with the freshest URL from
 * data.cms.gov → "Medicare Physician & Other Practitioners — by Provider".
 *
 * Stages into `medicare_utilization_raw` (created ad-hoc by this script,
 * since utilisation is the only consumer). Emits `high_utilization` signals
 * for facilities exceeding the 80th-percentile beneficiary count per HCPCS
 * code in the relevant modality.
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

const SOURCE_NAME = "medicare_utilization";

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function runMedicareUtilizationSeed(opts: {
  url?: string;
  force?: boolean;
} = {}): Promise<{ rowsStaged: number; signalsInserted: number }> {
  if (!opts.url) {
    throw new Error(
      "Medicare utilization seed requires --url <bulk CSV URL>. Find latest at " +
        "https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners",
    );
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS medicare_utilization_raw (
      ingested_at      timestamptz NOT NULL DEFAULT now(),
      npi              text NOT NULL,
      hcpcs_cd         text NOT NULL,
      tot_benes        integer,
      tot_srvcs        integer,
      avg_mdcr_pymt_amt numeric(18,2),
      provider_type    text,
      place_of_service text,
      PRIMARY KEY (npi, hcpcs_cd)
    )
  `);

  const filename = path.basename(new URL(opts.url).pathname) || "medicare_utilization.csv";
  const dl = await downloadFile({ url: opts.url, subdir: "medicare-utilization", filename });

  if (!opts.force && (await hasSuccessfulSeed(SOURCE_NAME, dl.sha256))) {
    logger.info({ sha256: dl.sha256 }, "medicare-utilization: cached, skipping");
    return { rowsStaged: 0, signalsInserted: 0 };
  }

  const runId = await startSeedRun({
    sourceName: SOURCE_NAME,
    fileUrl: opts.url,
    fileSha256: dl.sha256,
    fileBytes: dl.bytes,
  });

  try {
    const rowsStaged = await stageMedicareCsv(dl.path);
    const signalsInserted = await transformMedicare();
    await finishSeedRun(runId, { status: "ok", rowsStaged, signalsInserted });
    return { rowsStaged, signalsInserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishSeedRun(runId, { status: "failed", errorMessage: msg });
    throw err;
  }
}

async function stageMedicareCsv(csvPath: string): Promise<number> {
  return withProgress("medicare-utilization:stage", async (tick) => {
    await db.execute(sql`TRUNCATE TABLE medicare_utilization_raw`);
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
        total += await flushMedicareBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) total += await flushMedicareBatch(batch);
    return total;
  });
}

async function flushMedicareBatch(batch: Array<Record<string, string>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const npi = (r.Rndrng_NPI ?? r.npi ?? r.RNDRNG_NPI ?? "").trim();
    const hcpcs = (r.HCPCS_Cd ?? r.hcpcs_cd ?? r.HCPCS_CD ?? "").trim();
    if (!npi || !hcpcs) continue;
    tuples.push(
      `(${lit(npi)}, ${lit(hcpcs)}, ${lit(num(r.Tot_Benes ?? r.tot_benes))}, ` +
        `${lit(num(r.Tot_Srvcs ?? r.tot_srvcs))}, ` +
        `${lit(num(r.Avg_Mdcr_Pymt_Amt ?? r.avg_mdcr_pymt_amt))}, ` +
        `${lit(r.Rndrng_Prvdr_Type ?? r.provider_type)}, ` +
        `${lit(r.Place_Of_Srvc ?? r.place_of_service)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO medicare_utilization_raw (
      npi, hcpcs_cd, tot_benes, tot_srvcs, avg_mdcr_pymt_amt,
      provider_type, place_of_service
    ) VALUES ${tuples.join(",")}
    ON CONFLICT (npi, hcpcs_cd) DO UPDATE SET
      tot_benes         = EXCLUDED.tot_benes,
      tot_srvcs         = EXCLUDED.tot_srvcs,
      avg_mdcr_pymt_amt = EXCLUDED.avg_mdcr_pymt_amt,
      provider_type     = EXCLUDED.provider_type,
      place_of_service  = EXCLUDED.place_of_service,
      ingested_at       = now()
  `));
  return tuples.length;
}

async function transformMedicare(): Promise<number> {
  // For each HCPCS code, find providers above the 80th-percentile beneficiary
  // count and emit `high_utilization` signals against the matching facility.
  const res = await db.execute<{ id: string }>(sql`
    WITH pct AS (
      SELECT hcpcs_cd,
             PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY tot_benes) AS p80
        FROM medicare_utilization_raw
       WHERE tot_benes IS NOT NULL
       GROUP BY hcpcs_cd
       HAVING COUNT(*) >= 50
    ),
    high AS (
      SELECT m.npi, m.hcpcs_cd, m.tot_benes, m.tot_srvcs
        FROM medicare_utilization_raw m
        JOIN pct p ON p.hcpcs_cd = m.hcpcs_cd
       WHERE m.tot_benes >= p.p80
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, signal_date,
      source_name, confidence_score, payload, status
    )
    SELECT f.id,
           'high_utilization'::signal_type,
           'medicare:' || h.npi || ':' || h.hcpcs_cd,
           now()::date,
           'medicare_utilization',
           65,
           jsonb_build_object(
             'npi', h.npi,
             'hcpcs', h.hcpcs_cd,
             'beneficiaries', h.tot_benes,
             'services', h.tot_srvcs
           ),
           'active'
      FROM high h
      JOIN facilities f ON f.npi = h.npi
    ON CONFLICT (facility_id, signal_type, signal_value) DO NOTHING
    RETURNING id
  `);
  return res.rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  runMedicareUtilizationSeed({
    url: typeof flags.url === "string" ? flags.url : undefined,
    force: flags.force === true,
  })
    .then((r) => {
      logger.info(r, "medicare-utilization: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "medicare-utilization: seed failed");
      process.exit(1);
    });
}
