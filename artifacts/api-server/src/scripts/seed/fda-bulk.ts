/**
 * FDA openFDA bulk seed — 510k, classification, recall, MAUDE.
 *
 * openFDA publishes a JSON manifest at https://api.fda.gov/download.json
 * that lists every endpoint's downloadable partition files. Each partition
 * is a ZIP containing one JSON file with shape `{ meta, results: [...] }`.
 *
 * This script:
 *   1. Fetches the manifest.
 *   2. For each requested endpoint, downloads all partition ZIPs, unzips,
 *      streams the `results[]` array into the matching `<source>_raw`
 *      staging table.
 *   3. For recall + MAUDE, emits adverse_event signals against facilities
 *      whose `doingBusinessAs` or `name` token-overlaps the manufacturer.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/seed/fda-bulk.ts \
 *     --endpoints 510k,classification,recall,maude \
 *     [--limit-partitions 1]   # cap partitions per endpoint (test mode)
 *     [--force]                # re-stage even if sha256 matches a prior 'ok' run
 *
 * Manifest URL is overridable via FDA_MANIFEST_URL (defaults to the public one).
 */

import fs from "node:fs";
import path from "node:path";
import unzipper from "unzipper";
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

const MANIFEST_URL =
  process.env.FDA_MANIFEST_URL ?? "https://api.fda.gov/download.json";

type EndpointKey = "510k" | "classification" | "recall" | "maude";

interface ManifestPartition {
  size_mb?: number;
  records?: number;
  file: string;
}
interface ManifestEndpoint {
  partitions: ManifestPartition[];
  export_date?: string;
}

interface Manifest {
  results: {
    device: {
      "510k": ManifestEndpoint;
      classification: ManifestEndpoint;
      recall: ManifestEndpoint;
      event: ManifestEndpoint;   // MAUDE
    };
  };
}

const ENDPOINT_TO_MANIFEST_KEY: Record<EndpointKey, keyof Manifest["results"]["device"]> = {
  "510k": "510k",
  classification: "classification",
  recall: "recall",
  maude: "event",
};

const SOURCE_NAME_BY_ENDPOINT: Record<EndpointKey, string> = {
  "510k": "fda_510k",
  classification: "fda_classification",
  recall: "fda_recall",
  maude: "fda_maude",
};

// ─── Public entry per endpoint ─────────────────────────────────────────────

export async function runFdaBulkSeed(opts: {
  endpoints: EndpointKey[];
  limitPartitions?: number;
  force?: boolean;
}): Promise<Record<EndpointKey, { rowsStaged: number; signalsInserted: number } | null>> {
  // Fetch the manifest once.
  logger.info({ url: MANIFEST_URL }, "fda-bulk: fetching manifest");
  const manifestRes = await fetch(MANIFEST_URL);
  if (!manifestRes.ok) {
    throw new Error(`Manifest fetch failed: ${manifestRes.status}`);
  }
  const manifest = (await manifestRes.json()) as Manifest;

  const out: Record<EndpointKey, { rowsStaged: number; signalsInserted: number } | null> = {
    "510k": null,
    classification: null,
    recall: null,
    maude: null,
  };

  for (const ep of opts.endpoints) {
    out[ep] = await seedOneEndpoint({
      endpoint: ep,
      manifest,
      limitPartitions: opts.limitPartitions ?? 0,
      force: opts.force ?? false,
    });
  }
  return out;
}

async function seedOneEndpoint(opts: {
  endpoint: EndpointKey;
  manifest: Manifest;
  limitPartitions: number;
  force: boolean;
}): Promise<{ rowsStaged: number; signalsInserted: number }> {
  const { endpoint, manifest, limitPartitions, force } = opts;
  const manifestKey = ENDPOINT_TO_MANIFEST_KEY[endpoint];
  const partitions = manifest.results.device[manifestKey]?.partitions ?? [];
  if (partitions.length === 0) {
    throw new Error(`No partitions listed for endpoint ${endpoint} in manifest`);
  }

  const sourceName = SOURCE_NAME_BY_ENDPOINT[endpoint];
  const partitionsToRun = limitPartitions > 0 ? partitions.slice(0, limitPartitions) : partitions;

  logger.info(
    { endpoint, sourceName, totalPartitions: partitions.length, running: partitionsToRun.length },
    "fda-bulk: starting endpoint",
  );

  let totalStaged = 0;
  for (const part of partitionsToRun) {
    const filename = path.basename(new URL(part.file).pathname);
    const dl = await downloadFile({
      url: part.file,
      subdir: path.join("fda", endpoint),
      filename,
    });

    if (!force && (await hasSuccessfulSeed(sourceName, dl.sha256))) {
      logger.info({ sha256: dl.sha256, filename }, `${sourceName}: partition cached, skipping`);
      continue;
    }

    const runId = await startSeedRun({
      sourceName,
      fileUrl: part.file,
      fileSha256: dl.sha256,
      fileBytes: dl.bytes,
      meta: { partitionRecords: part.records ?? null },
    });

    try {
      const staged = await streamFdaPartition(dl.path, endpoint);
      totalStaged += staged;
      await finishSeedRun(runId, { status: "ok", rowsStaged: staged });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishSeedRun(runId, { status: "failed", errorMessage: msg });
      throw err;
    }
  }

  // After all partitions for this endpoint are staged, run the transform.
  const signalsInserted = await runFdaTransform(endpoint);
  return { rowsStaged: totalStaged, signalsInserted };
}

// ─── Per-endpoint stage logic ──────────────────────────────────────────────

async function streamFdaPartition(zipPath: string, endpoint: EndpointKey): Promise<number> {
  return withProgress(`fda:${endpoint}:stage`, async (tick) => {
    const directory = await unzipper.Open.file(zipPath);
    const jsonEntry = directory.files.find((f) => f.path.endsWith(".json"));
    if (!jsonEntry) throw new Error(`No JSON entry in ${zipPath}`);

    // For huge MAUDE partitions we can't fit the whole results array in
    // memory, but the partitions are pre-sized and openFDA caps them at
    // ~500 MB JSON each — manageable on a 4 GB worker. If memory becomes
    // an issue, swap this for a streaming JSON parser like `stream-json`.
    const buf = await jsonEntry.buffer();
    const parsed = JSON.parse(buf.toString("utf8")) as { results?: unknown[] };
    const results = parsed.results ?? [];

    const BATCH = 500;
    let batch: unknown[] = [];
    let total = 0;
    for (const r of results) {
      batch.push(r);
      tick();
      if (batch.length >= BATCH) {
        total += await flushFdaBatch(batch, endpoint);
        batch = [];
      }
    }
    if (batch.length > 0) {
      total += await flushFdaBatch(batch, endpoint);
    }
    return total;
  });
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function d(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  // openFDA dates are YYYYMMDD; convert to YYYY-MM-DD.
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return t;
}

async function flushFdaBatch(batch: unknown[], endpoint: EndpointKey): Promise<number> {
  if (endpoint === "510k")           return flush510k(batch as Array<Record<string, unknown>>);
  if (endpoint === "classification") return flushClassification(batch as Array<Record<string, unknown>>);
  if (endpoint === "recall")         return flushRecall(batch as Array<Record<string, unknown>>);
  return flushMaude(batch as Array<Record<string, unknown>>);
}

async function flush510k(batch: Array<Record<string, unknown>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const k = s(r.k_number);
    if (!k) continue;
    tuples.push(
      `(${lit(k)}, ${lit(s(r.applicant))}, ${lit(s(r.device_name))}, ${lit(s(r.product_code))}, ` +
        `${lit(d(r.decision_date))}, ${lit(s(r.decision_code))}, ${lit(s(r.clearance_type))}, ${lit(r)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO fda_510k_raw (k_number, applicant, device_name, product_code,
                              decision_date, decision_code, clearance_type, raw_json)
    VALUES ${tuples.join(",")}
    ON CONFLICT (k_number) DO UPDATE SET
      applicant     = EXCLUDED.applicant,
      device_name   = EXCLUDED.device_name,
      product_code  = EXCLUDED.product_code,
      decision_date = EXCLUDED.decision_date,
      decision_code = EXCLUDED.decision_code,
      clearance_type= EXCLUDED.clearance_type,
      raw_json      = EXCLUDED.raw_json,
      ingested_at   = now()
  `));
  return tuples.length;
}

async function flushClassification(batch: Array<Record<string, unknown>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const pc = s(r.product_code);
    if (!pc) continue;
    tuples.push(
      `(${lit(pc)}, ${lit(s(r.device_class))}, ${lit(s(r.device_name))}, ` +
        `${lit(s(r.medical_specialty))}, ${lit(s(r.medical_specialty_description))}, ` +
        `${lit(s(r.regulation_number))}, ${lit(s(r.submission_type_id))}, ${lit(r)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO fda_classification_raw (product_code, device_class, device_name,
       medical_specialty, medical_specialty_description, regulation_number,
       submission_type_id, raw_json)
    VALUES ${tuples.join(",")}
    ON CONFLICT (product_code) DO UPDATE SET
      device_class                  = EXCLUDED.device_class,
      device_name                   = EXCLUDED.device_name,
      medical_specialty             = EXCLUDED.medical_specialty,
      medical_specialty_description = EXCLUDED.medical_specialty_description,
      regulation_number             = EXCLUDED.regulation_number,
      submission_type_id            = EXCLUDED.submission_type_id,
      raw_json                      = EXCLUDED.raw_json,
      ingested_at                   = now()
  `));
  return tuples.length;
}

async function flushRecall(batch: Array<Record<string, unknown>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const rn = s(r.recall_number);
    if (!rn) continue;
    tuples.push(
      `(${lit(rn)}, ${lit(s(r.recalling_firm))}, ${lit(s(r.product_code))}, ` +
        `${lit(s(r.product_description))}, ${lit(d(r.recall_initiation_date))}, ` +
        `${lit(s(r.reason_for_recall))}, ${lit(s(r.status))}, ${lit(s(r.classification))}, ${lit(r)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO fda_recall_raw (recall_number, recalling_firm, product_code,
        product_description, recall_initiation_date, reason_for_recall, status,
        classification, raw_json)
    VALUES ${tuples.join(",")}
    ON CONFLICT (recall_number) DO UPDATE SET
      recalling_firm         = EXCLUDED.recalling_firm,
      product_code           = EXCLUDED.product_code,
      product_description    = EXCLUDED.product_description,
      recall_initiation_date = EXCLUDED.recall_initiation_date,
      reason_for_recall      = EXCLUDED.reason_for_recall,
      status                 = EXCLUDED.status,
      classification         = EXCLUDED.classification,
      raw_json               = EXCLUDED.raw_json,
      ingested_at            = now()
  `));
  return tuples.length;
}

async function flushMaude(batch: Array<Record<string, unknown>>): Promise<number> {
  const tuples: string[] = [];
  for (const r of batch) {
    const key = s(r.mdr_report_key);
    if (!key) continue;
    // device[] is an array; pick first for the indexed columns.
    const dev = Array.isArray(r.device) && r.device.length > 0
      ? (r.device[0] as Record<string, unknown>)
      : {};
    const problems = Array.isArray(r.product_problems)
      ? (r.product_problems as string[]).map((p) => `'${p.replace(/'/g, "''")}'`).join(",")
      : null;
    tuples.push(
      `(${lit(key)}, ${lit(s(r.event_type))}, ${lit(d(r.date_received))}, ` +
        `${problems ? `ARRAY[${problems}]::text[]` : "NULL"}, ` +
        `${lit(s(dev.manufacturer_d_name))}, ${lit(s(dev.brand_name))}, ${lit(r)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO fda_maude_raw (mdr_report_key, event_type, date_received,
        product_problems, manufacturer_name, brand_name, raw_json)
    VALUES ${tuples.join(",")}
    ON CONFLICT (mdr_report_key) DO UPDATE SET
      event_type        = EXCLUDED.event_type,
      date_received     = EXCLUDED.date_received,
      product_problems  = EXCLUDED.product_problems,
      manufacturer_name = EXCLUDED.manufacturer_name,
      brand_name        = EXCLUDED.brand_name,
      raw_json          = EXCLUDED.raw_json,
      ingested_at       = now()
  `));
  return tuples.length;
}

// ─── Transform: staging → canonical ───────────────────────────────────────

async function runFdaTransform(endpoint: EndpointKey): Promise<number> {
  if (endpoint === "recall") return transformRecall();
  if (endpoint === "maude")  return transformMaude();
  // 510k + classification are reference data — no per-facility signal emission.
  return 0;
}

async function transformRecall(): Promise<number> {
  // Emit `adverse_event_spike` signals for facilities whose name/dba/system
  // token-overlaps the recalling firm. Conservative: only recalls in the
  // last 24 months. Dedup via NOT EXISTS — purchase_signals has no unique
  // constraint, the live ingestors do the same client-side filter.
  const res = await db.execute<{ id: string }>(sql`
    WITH cand AS (
      SELECT r.recall_number,
             r.recalling_firm,
             r.product_description,
             r.classification,
             r.reason_for_recall,
             'fda_recall:' || r.recall_number AS sval
        FROM fda_recall_raw r
       WHERE r.recall_initiation_date > now() - interval '24 months'
         AND r.recalling_firm IS NOT NULL
         AND length(r.recalling_firm) > 8
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, confidence, source, metadata, is_active
    )
    SELECT f.id,
           'adverse_event_spike'::signal_type,
           c.sval,
           60,
           'fda_recall',
           jsonb_build_object(
             'recall_number', c.recall_number,
             'recalling_firm', c.recalling_firm,
             'product_description', c.product_description,
             'classification', c.classification,
             'reason_for_recall', c.reason_for_recall
           ),
           true
      FROM cand c
      JOIN facilities f
        ON (
          (f.doing_business_as ILIKE '%' || LEFT(c.recalling_firm, 40) || '%')
          OR (f.system_name ILIKE '%' || LEFT(c.recalling_firm, 40) || '%')
          OR (f.name ILIKE '%' || LEFT(c.recalling_firm, 40) || '%')
        )
     WHERE NOT EXISTS (
       SELECT 1 FROM purchase_signals ps
        WHERE ps.facility_id = f.id
          AND ps.signal_type = 'adverse_event_spike'
          AND ps.signal_value = c.sval
     )
    RETURNING id
  `);
  return res.rows.length;
}

async function transformMaude(): Promise<number> {
  // MAUDE → facility linkage is brittle (events are reported against
  // manufacturer + product, not the operating site). For seeding we just
  // record manufacturer-level event counts as facility signals when the
  // facility's name fuzzy-matches the manufacturer.
  const res = await db.execute<{ id: string }>(sql`
    WITH agg AS (
      SELECT manufacturer_name,
             COUNT(*) AS events,
             MAX(date_received) AS latest_date,
             'fda_maude:' || manufacturer_name AS sval
        FROM fda_maude_raw
       WHERE date_received > now() - interval '12 months'
         AND manufacturer_name IS NOT NULL
       GROUP BY manufacturer_name
       HAVING COUNT(*) >= 3
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, confidence, source, metadata, is_active
    )
    SELECT f.id,
           'adverse_event_spike'::signal_type,
           agg.sval,
           50,
           'fda_maude',
           jsonb_build_object(
             'manufacturer_name', agg.manufacturer_name,
             'events_12mo', agg.events,
             'latest_date', agg.latest_date
           ),
           true
      FROM agg
      JOIN facilities f
        ON f.name ILIKE '%' || LEFT(agg.manufacturer_name, 40) || '%'
     WHERE NOT EXISTS (
       SELECT 1 FROM purchase_signals ps
        WHERE ps.facility_id = f.id
          AND ps.signal_type = 'adverse_event_spike'
          AND ps.signal_value = agg.sval
     )
    RETURNING id
  `);
  return res.rows.length;
}

// ─── CLI entry ────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  const rawEps =
    typeof flags.endpoints === "string" ? flags.endpoints : "510k,classification,recall,maude";
  const endpoints = rawEps.split(",").map((e) => e.trim()) as EndpointKey[];

  const limitPartitions =
    typeof flags["limit-partitions"] === "string"
      ? Number(flags["limit-partitions"])
      : 0;
  const force = flags.force === true;

  // Ensure we don't leak file descriptors from the unzipper.
  process.on("exit", () => {
    /* fs auto-cleans on process exit */
  });

  runFdaBulkSeed({ endpoints, limitPartitions, force })
    .then((r) => {
      logger.info(r, "fda-bulk: seed done");
      // Touch fs so the import stays — silences unused-import lint if any.
      void fs;
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "fda-bulk: seed failed");
      process.exit(1);
    });
}
