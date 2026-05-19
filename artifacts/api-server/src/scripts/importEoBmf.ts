/**
 * IRS EO Business Master File (BMF) → facilities EIN matcher  (Task #104)
 *
 * Problem: only ~944 of 183k facilities have an EIN linked, because the
 * import-990 script only writes facility.ein when a 990 row already exists in
 * irs_990_raw. The vast majority of facilities have never been matched.
 *
 * Solution: the BMF CSVs (eo1/eo2/eo3) carry EIN + NAME + STATE for every
 * IRS-exempt organisation — ~1.26 M entries. We can fuzzy-match BMF NAME
 * against facilities.name with pg_trgm to link EINs for tens of thousands of
 * additional facilities without relying on irs_990_raw at all.
 *
 * Algorithm:
 *   1. Stream all three BMF CSVs into a Map<ein, {name, state}>.
 *   2. Bulk-load that map into a PostgreSQL TEMP TABLE (bmf_staging),
 *      batching inserts to stay well under the 65,535-parameter limit.
 *   3. CREATE a GIN trgm index on bmf_staging.name so the similarity join
 *      can use it from the facilities side.
 *   4. Run a keyset-batched UPDATE: for each slice of unmatched facilities,
 *      find the highest-similarity BMF entry (>= 0.6), write its EIN.
 *      Pass A (general): similarity >= 0.6 for all unmatched facilities.
 *      Pass B (hospital): similarity >= 0.5 for facilities where
 *        operates_hospital = true and still unmatched after Pass A.
 *   5. Print final stats and exit 0.
 *
 * After this script completes, run:
 *   pnpm --filter @workspace/api-server run import-990  (with IRS_990_SIGNALS_ONLY=1)
 * to emit the 4 signal types for all newly matched facilities.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run import-eo-bmf
 *
 * Env overrides:
 *   BMF_BATCH_SIZE   Facilities per trgm batch  (default: 200)
 *   BMF_THRESHOLD    Similarity floor, Pass A   (default: 0.6)
 *   BMF_HOSP_THRESH  Similarity floor, Pass B   (default: 0.6, same spec floor)
 */

export {};

import path from "node:path";
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// ─── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT     = path.resolve(import.meta.dirname, "../../../../");
const BMF_FILES     = [
  path.join(REPO_ROOT, "attached_assets/eo1_1779206848043.csv"),
  path.join(REPO_ROOT, "attached_assets/eo2_1779206844990.csv"),
  path.join(REPO_ROOT, "attached_assets/eo3_1779206841644.csv"),
];

const BATCH_SIZE    = Math.max(50, Number(process.env.BMF_BATCH_SIZE  ?? 200));
const THRESHOLD     = Number(process.env.BMF_THRESHOLD    ?? 0.6);
const HOSP_THRESH   = Number(process.env.BMF_HOSP_THRESH  ?? 0.6);
const STAGING_BATCH = 500;   // rows per INSERT into bmf_staging

function fmt(n: number) { return n.toLocaleString("en-US"); }

// ─── Step 1: Stream BMF CSVs into an EIN→{name,state} map ────────────────────

interface BmfEntry { name: string; state: string }

async function loadBmf(): Promise<Map<string, BmfEntry>> {
  const map = new Map<string, BmfEntry>();

  for (const filePath of BMF_FILES) {
    await new Promise<void>((resolve, reject) => {
      const parser = parse({
        columns:            true,
        skip_empty_lines:   true,
        trim:               true,
        relax_column_count: true,
      });

      createReadStream(filePath)
        .on("error", reject)
        .pipe(parser);

      parser.on("data", (row: Record<string, string>) => {
        const ein   = (row["EIN"]   ?? "").replace(/\D/g, "").padStart(9, "0").slice(0, 9);
        const name  = (row["NAME"]  ?? "").trim();
        const state = (row["STATE"] ?? "").trim().toUpperCase();
        if (ein.length === 9 && name && !map.has(ein)) {
          map.set(ein, { name, state });
        }
      });

      parser.on("end",   resolve);
      parser.on("error", reject);
    });

    console.log(`  Loaded ${path.basename(filePath)} — running total: ${fmt(map.size)} EINs`);
  }

  return map;
}

// ─── Step 2: Bulk-load map into bmf_staging temp table ───────────────────────

async function loadStaging(map: Map<string, BmfEntry>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TEMP TABLE IF NOT EXISTS bmf_staging (
      ein   varchar(9) PRIMARY KEY,
      name  text       NOT NULL,
      state char(2)
    )
  `));

  const entries = [...map.entries()];
  let inserted  = 0;

  for (let i = 0; i < entries.length; i += STAGING_BATCH) {
    const batch  = entries.slice(i, i + STAGING_BATCH);
    const values = batch
      .map(([ein, { name, state }]) => {
        const safeName  = name.replace(/'/g, "''");
        const safeState = state ? `'${state.replace(/'/g, "''")}'` : "NULL";
        return `('${ein}','${safeName}',${safeState})`;
      })
      .join(",");

    await db.execute(sql.raw(`
      INSERT INTO bmf_staging (ein, name, state)
      VALUES ${values}
      ON CONFLICT (ein) DO NOTHING
    `));

    inserted += batch.length;
    if (inserted % 100_000 < STAGING_BATCH) {
      console.log(`    Staging: ${fmt(inserted)} / ${fmt(entries.length)} rows inserted`);
    }
  }

  console.log(`  Staging table populated: ${fmt(inserted)} rows total.`);
}

// ─── Step 3: Create GIN trgm index on bmf_staging.name ───────────────────────

async function createStagingIndex(): Promise<void> {
  console.log("  Creating GIN trgm index on bmf_staging.name ...");
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS bmf_staging_name_trgm
      ON bmf_staging USING gin (name gin_trgm_ops)
  `));
  console.log("  Index ready.");
}

// ─── Step 4: Batched pg_trgm match ───────────────────────────────────────────

async function runPass(threshold: number, hospitalOnly: boolean): Promise<number> {
  const label = hospitalOnly ? `hospital pass (threshold=${threshold})` : `general pass (threshold=${threshold})`;
  console.log(`\n  Starting ${label} ...`);

  const allFacIds = (await db.execute<{ id: string }>(sql.raw(`
    SELECT id
    FROM   facilities
    WHERE  ein IS NULL
      ${hospitalOnly ? "AND operates_hospital = true" : ""}
    ORDER BY id
  `))).rows.map((r) => r.id);

  console.log(`    Unmatched facilities in scope: ${fmt(allFacIds.length)}`);
  if (allFacIds.length === 0) return 0;

  let matched = 0;

  for (let i = 0; i < allFacIds.length; i += BATCH_SIZE) {
    const slice   = allFacIds.slice(i, i + BATCH_SIZE);
    const idList  = slice.map((id) => `'${id}'`).join(", ");

    const res = await db.execute<{ cnt: string }>(sql.raw(`
      WITH candidates AS (
        SELECT
          f.id                             AS fac_id,
          b.ein,
          similarity(f.name, b.name)       AS sim
        FROM facilities   f
        JOIN bmf_staging  b
             ON similarity(f.name, b.name) >= ${threshold}
        WHERE f.id IN (${idList})
          AND f.ein IS NULL
      ),
      ranked AS (
        SELECT fac_id, ein, sim,
          ROW_NUMBER() OVER (PARTITION BY fac_id ORDER BY sim DESC) AS rn
        FROM candidates
      ),
      upd AS (
        UPDATE facilities f
        SET    ein        = ranked.ein,
               updated_at = now()
        FROM   ranked
        WHERE  f.id  = ranked.fac_id
          AND  ranked.rn = 1
          AND  f.ein IS NULL
        RETURNING f.id
      )
      SELECT COUNT(*)::text AS cnt FROM upd
    `));

    matched += Number(res.rows[0]?.cnt ?? 0);

    if ((i / BATCH_SIZE) % 50 === 0 && i > 0) {
      console.log(`    ... processed ${fmt(i + slice.length)} / ${fmt(allFacIds.length)} facilities, ${fmt(matched)} matched so far`);
    }
  }

  console.log(`  ${label}: ${fmt(matched)} EINs written to facilities.`);
  return matched;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(68));
console.log("  MedIntel OS — IRS EO BMF → Facilities EIN Matcher");
console.log(`  BMF files    : ${BMF_FILES.map((f) => path.basename(f)).join(", ")}`);
console.log(`  Threshold A  : general  >= ${THRESHOLD}  (override: BMF_THRESHOLD)`);
console.log(`  Threshold B  : hospital >= ${HOSP_THRESH}  (override: BMF_HOSP_THRESH)`);
console.log(`  Batch size   : ${fmt(BATCH_SIZE)} facilities`);
console.log("═".repeat(68) + "\n");

await db.execute(sql`SELECT 1`).catch((err) => {
  console.error("DB connection failed:", String(err));
  process.exit(1);
});
console.log("  DB connected.\n");

const t0 = Date.now();

// Baseline
const [before] = (await db.execute<{ total: string; matched: string }>(sql.raw(`
  SELECT
    COUNT(*)::text                              AS total,
    COUNT(*) FILTER (WHERE ein IS NOT NULL)::text AS matched
  FROM facilities
`))).rows;
console.log(`  Baseline: ${fmt(Number(before.matched))} / ${fmt(Number(before.total))} facilities have an EIN.\n`);

// Step 1
console.log("[1/4] Loading BMF CSVs into memory...");
const bmfMap = await loadBmf();
console.log(`  Total distinct EINs loaded: ${fmt(bmfMap.size)}\n`);

// Step 2
console.log("[2/4] Bulk-loading into temp table bmf_staging...");
await loadStaging(bmfMap);

// Step 3
console.log("\n[3/4] Building GIN trgm index...");
await createStagingIndex();

// Step 4
console.log("\n[4/4] Running pg_trgm match passes...");
const generalMatched  = await runPass(THRESHOLD,    false);
const hospitalMatched = await runPass(HOSP_THRESH,  true);
const totalMatched    = generalMatched + hospitalMatched;

// Final stats
const [after] = (await db.execute<{ matched: string }>(sql.raw(`
  SELECT COUNT(*) FILTER (WHERE ein IS NOT NULL)::text AS matched
  FROM facilities
`))).rows;

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log("\n" + "═".repeat(68));
console.log("  Final metrics:");
console.log(`    BMF entries loaded          : ${fmt(bmfMap.size)}`);
console.log(`    EINs written — general pass : ${fmt(generalMatched)}`);
console.log(`    EINs written — hospital pass: ${fmt(hospitalMatched)}`);
console.log(`    EINs written — total        : ${fmt(totalMatched)}`);
console.log(`    Facilities with EIN (after) : ${fmt(Number(after.matched))}`);
console.log(`    Elapsed                     : ${elapsed}s`);
console.log("═".repeat(68));
console.log("\n  Next step: pnpm --filter @workspace/api-server run import-990");
console.log("  with IRS_990_SIGNALS_ONLY=1 to emit signals for all newly matched facilities.\n");

process.exit(0);
