/**
 * CMS Provider Data bulk seed — generic loader for any data.cms.gov dataset.
 *
 * data.cms.gov hosts dozens of provider-level datasets (hospital general info,
 * Medicare Spending Per Beneficiary, Outpatient Imaging Efficiency, Hospital
 * Readmissions, etc.). Each dataset has a stable distribution UUID that
 * resolves to a CSV via:
 *   https://data.cms.gov/provider-data/api/1/datastore/sql?query={SELECT * FROM <uuid>}
 *
 * For each registered dataset we run the same flow: fetch CSV → stage into
 * `cms_provider_raw (dataset_id, facility_key, raw_json)` keyed on the
 * dataset's facility identifier column. Downstream transforms can read
 * specific datasets from the raw table without re-fetching.
 *
 * Default registry covers the most operationally useful datasets. Operator
 * can pass --dataset <id>:<uuid>:<facility_key_column> to add one-offs.
 */

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
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";

const SOURCE_NAME = "cms_provider";

interface DatasetSpec {
  id: string;              // human-readable handle
  uuid: string;            // data.cms.gov distribution uuid
  facilityKeyCol: string;  // CCN or NPI column name in the CSV
}

const REGISTRY: DatasetSpec[] = [
  // Hospital General Information — beds, ownership, type, address.
  { id: "hospital_general_info",     uuid: "xubh-q36u", facilityKeyCol: "facility_id" },
  // Medicare Spending Per Beneficiary — Hospital.
  { id: "mspb_hospital",             uuid: "rrqw-56er", facilityKeyCol: "facility_id" },
  // Outpatient Imaging Efficiency — utilisation by hospital.
  { id: "outpatient_imaging",        uuid: "wkfw-kthe", facilityKeyCol: "facility_id" },
  // Hospital Readmissions Reduction Program — readmission penalty levels.
  { id: "hrrp_readmissions",         uuid: "9n3s-kdb3", facilityKeyCol: "facility_id" },
  // Provider of Services (POS) file — bed counts, service offerings.
  { id: "pos_inpatient",             uuid: "tmf6-yrcr", facilityKeyCol: "provider_number" },
];

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function runCmsProviderSeed(opts: {
  datasets?: DatasetSpec[];
  force?: boolean;
} = {}): Promise<{ rowsStaged: number; facilitiesUpdated: number }> {
  const datasets = opts.datasets ?? REGISTRY;
  let totalStaged = 0;

  for (const ds of datasets) {
    const url = `https://data.cms.gov/provider-data/api/1/datastore/query/${ds.uuid}/0/download?format=csv`;
    const filename = `${ds.id}.csv`;
    const dl = await downloadFile({ url, subdir: "cms-provider", filename });
    if (!opts.force && (await hasSuccessfulSeed(`${SOURCE_NAME}:${ds.id}`, dl.sha256))) {
      logger.info({ dataset: ds.id, sha256: dl.sha256 }, "cms-provider: cached, skipping");
      continue;
    }
    const runId = await startSeedRun({
      sourceName: `${SOURCE_NAME}:${ds.id}`,
      fileUrl: url,
      fileSha256: dl.sha256,
      fileBytes: dl.bytes,
      meta: { dataset: ds.id },
    });
    try {
      const rowsStaged = await stageCmsCsv(dl.path, ds);
      totalStaged += rowsStaged;
      await finishSeedRun(runId, { status: "ok", rowsStaged, meta: { dataset: ds.id } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishSeedRun(runId, { status: "failed", errorMessage: msg, meta: { dataset: ds.id } });
      throw err;
    }
  }

  const facilitiesUpdated = await transformCmsProvider();
  return { rowsStaged: totalStaged, facilitiesUpdated };
}

async function stageCmsCsv(csvPath: string, spec: DatasetSpec): Promise<number> {
  return withProgress(`cms-provider:stage:${spec.id}`, async (tick) => {
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
        total += await flushCmsBatch(batch, spec);
        batch = [];
      }
    }
    if (batch.length > 0) total += await flushCmsBatch(batch, spec);
    return total;
  });
}

async function flushCmsBatch(batch: Array<Record<string, string>>, spec: DatasetSpec): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const key = r[spec.facilityKeyCol] ?? r.ccn ?? r.cms_certification_number ?? r.npi;
    if (!key) continue;
    const state = r.state ?? r.facility_state ?? r.provider_state ?? null;
    tuples.push(`(${lit(spec.id)}, ${lit(key)}, ${lit(state)}, ${lit(r)})`);
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO cms_provider_raw (dataset_id, facility_key, state, raw_json)
    VALUES ${tuples.join(",")}
    ON CONFLICT (dataset_id, facility_key) DO UPDATE SET
      state       = EXCLUDED.state,
      raw_json    = EXCLUDED.raw_json,
      ingested_at = now()
  `));
  return tuples.length;
}

async function transformCmsProvider(): Promise<number> {
  // Pull beds + ownership from `hospital_general_info` into facilities.
  const res = await db.execute<{ id: string }>(sql`
    UPDATE facilities f
       SET beds = COALESCE(
                    NULLIF(c.raw_json->>'number_of_beds',''),
                    NULLIF(c.raw_json->>'hospital_beds','')
                  )::int,
           ownership = CASE
             WHEN c.raw_json->>'hospital_ownership' ILIKE '%government%' THEN 'government_owned'
             WHEN c.raw_json->>'hospital_ownership' ILIKE '%proprietary%' THEN 'for_profit_corporate'
             WHEN c.raw_json->>'hospital_ownership' ILIKE '%voluntary%non%profit%' THEN 'non_profit'
             ELSE f.ownership
           END
      FROM cms_provider_raw c
     WHERE c.dataset_id = 'hospital_general_info'
       AND f.cms_id = c.facility_key
       AND (f.beds IS NULL OR f.beds = 0)
    RETURNING f.id
  `);
  return res.rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  runCmsProviderSeed({ force: flags.force === true })
    .then((r) => {
      logger.info(r, "cms-provider: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "cms-provider: seed failed");
      process.exit(1);
    });
}
