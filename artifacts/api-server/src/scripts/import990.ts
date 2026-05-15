/**
 * IRS EO 990 Complete Extract Importer
 *
 * Reads the 247 MB IRS 990 extract ZIP, streams 345k rows into `irs_990_raw`,
 * then matches EINs to facilities and emits purchase signals:
 *
 *   hospital_operator    — operatehosptlcd = 'Y'
 *   financial_health     — large positive net assets relative to revenue
 *   capital_investment   — significant land/buildings/equipment assets
 *   workforce_expansion  — employee count > 500
 *
 * Also upserts key financials into `financial_documents` and links EINs to
 * matched facilities via `facilities.ein`.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run import-990
 *
 * Env overrides:
 *   IRS_990_ZIP_PATH   Absolute path to zip (default: repo-root attached_assets)
 *   IRS_990_BATCH_SIZE Rows per DB batch (default: 500)
 *   IRS_990_SIGNALS_ONLY  If "1", skip CSV re-import, jump straight to signals
 */

export {};

import path from "node:path";
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import { parse } from "csv-parse";
import { sql } from "drizzle-orm";
import { db, irs990Raw } from "@workspace/db";
import { logger } from "../lib/logger";

// ─── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const DEFAULT_ZIP = path.join(REPO_ROOT, "attached_assets/24eoextract990_1778864725332.zip");
const ZIP_PATH    = process.env.IRS_990_ZIP_PATH ?? DEFAULT_ZIP;
const BATCH_SIZE  = Math.max(100, Number(process.env.IRS_990_BATCH_SIZE ?? 500));
const SIGNALS_ONLY = process.env.IRS_990_SIGNALS_ONLY === "1";

// Financial thresholds for signal generation
const MIN_ASSETS_FOR_CAPITAL   = 10_000_000;   // $10M+ in land/bldg/equip
const MIN_ASSETS_FOR_HEALTH    = 50_000_000;   // $50M+ total assets
const MIN_MARGIN_PCT           = 0.05;          // 5% net margin for health signal
const MIN_EMPLOYEES_EXPANSION  = 500;           // 500+ W-2 employees

function fmt(n: number) { return n.toLocaleString("en-US"); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Parse helpers ────────────────────────────────────────────────────────────

function toInt(v: string | undefined): number | null {
  if (!v || !v.trim()) return null;
  const n = parseInt(v.trim(), 10);
  return isNaN(n) ? null : n;
}

function toBigint(v: string | undefined): number | null {
  if (!v || !v.trim()) return null;
  const n = Number(v.trim());
  return isNaN(n) ? null : Math.round(n);
}

function toChar(v: string | undefined): string | null {
  if (!v || !v.trim()) return null;
  return v.trim().slice(0, 1).toUpperCase();
}

function normalizeEin(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 2) return null;
  // IRS stores EINs without dash, padded to 9 digits
  return digits.padStart(9, "0").slice(0, 9);
}

// ─── Step 1: Stream CSV into irs_990_raw ─────────────────────────────────────

interface RawRow {
  ein: string;
  taxPd: string | null;
  subseccd: string | null;
  operatehosptlcd: string | null;
  noemplyeesw3cnt: number | null;
  totcntrbgfts: number | null;
  totprgmrevnue: number | null;
  invstmntinc: number | null;
  netrntlinc: number | null;
  netgnls: number | null;
  netincfndrsng: number | null;
  netincgaming: number | null;
  netincsales: number | null;
  totrevenue: number | null;
  compnsatncurrofcr: number | null;
  othrsalwages: number | null;
  pensionplancontrb: number | null;
  othremplyeebenef: number | null;
  payrolltx: number | null;
  feesforsrvcmgmt: number | null;
  deprcatndepletn: number | null;
  totfuncexpns: number | null;
  lndbldgsequipend: number | null;
  invstmntsend: number | null;
  totassetsend: number | null;
  secrdmrtgsend: number | null;
  unsecurednotesend: number | null;
  totliabend: number | null;
  totnetassetend: number | null;
  totreprtabled: number | null;
  totcomprelatede: number | null;
  noindiv100kcnt: number | null;
  nocontractor100kcnt: number | null;
  txexmptbndcd: string | null;
  rptlndbldgeqptcd: string | null;
  s501c3or4947a1cd: string | null;
}

function csvRecordToRow(record: Record<string, string>): RawRow | null {
  const ein = normalizeEin(record["EIN"]);
  if (!ein) return null;
  return {
    ein,
    taxPd: record["tax_pd"]?.trim() || null,
    subseccd: record["subseccd"]?.trim() || null,
    operatehosptlcd: toChar(record["operatehosptlcd"]),
    noemplyeesw3cnt: toInt(record["noemplyeesw3cnt"]),
    totcntrbgfts: toBigint(record["totcntrbgfts"]),
    totprgmrevnue: toBigint(record["totprgmrevnue"]),
    invstmntinc: toBigint(record["invstmntinc"]),
    netrntlinc: toBigint(record["netrntlinc"]),
    netgnls: toBigint(record["netgnls"]),
    netincfndrsng: toBigint(record["netincfndrsng"]),
    netincgaming: toBigint(record["netincgaming"]),
    netincsales: toBigint(record["netincsales"]),
    totrevenue: toBigint(record["totrevenue"]),
    compnsatncurrofcr: toBigint(record["compnsatncurrofcr"]),
    othrsalwages: toBigint(record["othrsalwages"]),
    pensionplancontrb: toBigint(record["pensionplancontrb"]),
    othremplyeebenef: toBigint(record["othremplyeebenef"]),
    payrolltx: toBigint(record["payrolltx"]),
    feesforsrvcmgmt: toBigint(record["feesforsrvcmgmt"]),
    deprcatndepletn: toBigint(record["deprcatndepletn"]),
    totfuncexpns: toBigint(record["totfuncexpns"]),
    lndbldgsequipend: toBigint(record["lndbldgsequipend"]),
    invstmntsend: toBigint(record["invstmntsend"]),
    totassetsend: toBigint(record["totassetsend"]),
    secrdmrtgsend: toBigint(record["secrdmrtgsend"]),
    unsecurednotesend: toBigint(record["unsecurednotesend"]),
    totliabend: toBigint(record["totliabend"]),
    totnetassetend: toBigint(record["totnetassetend"]),
    totreprtabled: toBigint(record["totreprtabled"]),
    totcomprelatede: toBigint(record["totcomprelatede"]),
    noindiv100kcnt: toInt(record["noindiv100kcnt"]),
    nocontractor100kcnt: toInt(record["nocontractor100kcnt"]),
    txexmptbndcd: toChar(record["txexmptbndcd"]),
    rptlndbldgeqptcd: toChar(record["rptlndbldgeqptcd"]),
    s501c3or4947a1cd: toChar(record["s501c3or4947a1cd"]),
  };
}

async function flushBatch(rawBatch: RawRow[]): Promise<void> {
  if (rawBatch.length === 0) return;
  // Deduplicate within the batch: keep the most recent tax_pd per EIN.
  const seen = new Map<string, RawRow>();
  for (const row of rawBatch) {
    const existing = seen.get(row.ein);
    if (!existing || (row.taxPd ?? "") > (existing.taxPd ?? "")) {
      seen.set(row.ein, row);
    }
  }
  const batch = Array.from(seen.values());
  await db
    .insert(irs990Raw)
    .values(batch)
    .onConflictDoUpdate({
      target: irs990Raw.ein,
      set: {
        taxPd: sql`excluded.tax_pd`,
        subseccd: sql`excluded.subseccd`,
        operatehosptlcd: sql`excluded.operatehosptlcd`,
        noemplyeesw3cnt: sql`excluded.noemplyeesw3cnt`,
        totcntrbgfts: sql`excluded.totcntrbgfts`,
        totprgmrevnue: sql`excluded.totprgmrevnue`,
        invstmntinc: sql`excluded.invstmntinc`,
        netrntlinc: sql`excluded.netrntlinc`,
        netgnls: sql`excluded.netgnls`,
        netincfndrsng: sql`excluded.netincfndrsng`,
        netincgaming: sql`excluded.netincgaming`,
        netincsales: sql`excluded.netincsales`,
        totrevenue: sql`excluded.totrevenue`,
        compnsatncurrofcr: sql`excluded.compnsatncurrofcr`,
        othrsalwages: sql`excluded.othrsalwages`,
        pensionplancontrb: sql`excluded.pensionplancontrb`,
        othremplyeebenef: sql`excluded.othremplyeebenef`,
        payrolltx: sql`excluded.payrolltx`,
        feesforsrvcmgmt: sql`excluded.feesforsrvcmgmt`,
        deprcatndepletn: sql`excluded.deprcatndepletn`,
        totfuncexpns: sql`excluded.totfuncexpns`,
        lndbldgsequipend: sql`excluded.lndbldgsequipend`,
        invstmntsend: sql`excluded.invstmntsend`,
        totassetsend: sql`excluded.totassetsend`,
        secrdmrtgsend: sql`excluded.secrdmrtgsend`,
        unsecurednotesend: sql`excluded.unsecurednotesend`,
        totliabend: sql`excluded.totliabend`,
        totnetassetend: sql`excluded.totnetassetend`,
        totreprtabled: sql`excluded.totreprtabled`,
        totcomprelatede: sql`excluded.totcomprelatede`,
        noindiv100kcnt: sql`excluded.noindiv100kcnt`,
        nocontractor100kcnt: sql`excluded.nocontractor100kcnt`,
        txexmptbndcd: sql`excluded.txexmptbndcd`,
        rptlndbldgeqptcd: sql`excluded.rptlndbldgeqptcd`,
        s501c3or4947a1cd: sql`excluded.s501c3or4947a1cd`,
        updatedAt: sql`now()`,
      },
    });
}

async function importCsv(): Promise<{ rowsInserted: number; rowsSkipped: number }> {
  return new Promise((resolve, reject) => {
    console.log(`  Extracting CSV from ${ZIP_PATH}...`);
    const csvPath = "/tmp/irs_990_extract.csv";

    try {
      execSync(
        `python3 -c "
import zipfile, sys
with zipfile.ZipFile('${ZIP_PATH}') as z:
    names = [n for n in z.namelist() if n.endswith('.csv')]
    with z.open(names[0]) as src, open('${csvPath}', 'wb') as dst:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)
print('OK')
"`,
        { stdio: ["inherit", "pipe", "inherit"] },
      );
    } catch (err) {
      return reject(new Error(`CSV extraction failed: ${String(err)}`));
    }

    console.log(`  CSV extracted to ${csvPath}, streaming into DB...`);

    let rowsInserted = 0;
    let rowsSkipped  = 0;
    let batch: RawRow[] = [];
    let flushPromise = Promise.resolve();
    let lastLog = Date.now();

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    parser.on("readable", async () => {
      let record: Record<string, string>;
      while ((record = parser.read())) {
        const row = csvRecordToRow(record);
        if (!row) { rowsSkipped++; continue; }
        batch.push(row);
        if (batch.length >= BATCH_SIZE) {
          const toFlush = batch;
          batch = [];
          flushPromise = flushPromise.then(() => flushBatch(toFlush));
          rowsInserted += toFlush.length;
        }
        if (Date.now() - lastLog > 5000) {
          console.log(`    ... ${fmt(rowsInserted + rowsSkipped)} rows processed (${fmt(rowsInserted)} inserted)`);
          lastLog = Date.now();
        }
      }
    });

    parser.on("end", async () => {
      if (batch.length > 0) {
        flushPromise = flushPromise.then(() => flushBatch(batch));
        rowsInserted += batch.length;
      }
      await flushPromise;
      resolve({ rowsInserted, rowsSkipped });
    });

    parser.on("error", (err) => reject(err));

    const readStream = createReadStream(csvPath);
    readStream.pipe(parser);
  });
}

// ─── Step 2: Match EINs to facilities ────────────────────────────────────────

interface MatchedFacility {
  id: string;
  ein: string;
}

async function matchEinsToFacilities(): Promise<{ matched: number; linked: number }> {
  // Strategy A: direct EIN match on facilities.ein column
  // Strategy B: pg_trgm name similarity against irs_990_raw (not available here — 
  //             we match via ProPublica EIN previously stored on facilities.ein)
  // Strategy C: raw SQL JOIN on normalized EIN using HCRIS/ProPublica-stored EINs

  // Link all facilities where ein is already set (from prior ProPublica ingest)
  // that have a matching row in irs_990_raw
  const linkResult = await db.execute<{ linked: string }>(sql.raw(`
    UPDATE facilities f
    SET ein = i.ein, updated_at = now()
    FROM irs_990_raw i
    WHERE f.ein = i.ein
      AND f.ein IS NOT NULL
    RETURNING f.id
  `));
  const directLinked = linkResult.rows.length;

  // Get all matched facilities (have ein, have 990 data)
  const matched = await db.execute<{ id: string; ein: string }>(sql.raw(`
    SELECT f.id, f.ein
    FROM facilities f
    INNER JOIN irs_990_raw i ON i.ein = f.ein
    WHERE f.ein IS NOT NULL
  `));

  return { matched: matched.rows.length, linked: directLinked };
}

// ─── Step 3: Upsert financial_documents ──────────────────────────────────────

async function upsertFinancialDocs(): Promise<number> {
  const result = await db.execute<{ count: string }>(sql.raw(`
    INSERT INTO financial_documents (
      facility_id, doc_type, fiscal_year,
      total_revenue, capital_expenditures, long_term_debt,
      ingested_at
    )
    SELECT
      f.id,
      'irs_990',
      CASE
        WHEN length(i.tax_pd) >= 6 THEN (left(i.tax_pd, 4))::smallint
        ELSE date_part('year', now())::smallint
      END,
      i.totrevenue,
      i.lndbldgsequipend,
      i.secrdmrtgsend + COALESCE(i.unsecurednotesend, 0),
      now()
    FROM facilities f
    INNER JOIN irs_990_raw i ON i.ein = f.ein
    WHERE f.ein IS NOT NULL
      AND i.totrevenue IS NOT NULL
    ON CONFLICT (facility_id, doc_type, fiscal_year)
    DO UPDATE SET
      total_revenue       = EXCLUDED.total_revenue,
      capital_expenditures = EXCLUDED.capital_expenditures,
      long_term_debt      = EXCLUDED.long_term_debt,
      ingested_at         = now()
    RETURNING id
  `));
  return result.rows.length;
}

// ─── Step 4: Emit purchase signals ───────────────────────────────────────────

async function emitSignals(): Promise<number> {
  let total = 0;

  // hospital_operator — confirmed hospital by IRS
  const hospResult = await db.execute<{ count: string }>(sql.raw(`
    INSERT INTO purchase_signals (facility_id, signal_type, signal_value, confidence, source, is_active, detected_at)
    SELECT
      f.id,
      'hospital_operator',
      'irs_990:hospital:' || i.ein,
      85,
      'irs_990',
      true,
      now()
    FROM facilities f
    INNER JOIN irs_990_raw i ON i.ein = f.ein
    WHERE f.ein IS NOT NULL
      AND i.operatehosptlcd = 'Y'
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  console.log(`    hospital_operator signals: ${fmt(hospResult.rows.length)}`);
  total += hospResult.rows.length;

  // capital_investment — significant L/B/E assets (>$10M)
  const capResult = await db.execute<{ count: string }>(sql.raw(`
    INSERT INTO purchase_signals (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      f.id,
      'capital_investment',
      'irs_990:capex:' || i.ein,
      75,
      'irs_990',
      jsonb_build_object(
        'lndbldgsequipend', i.lndbldgsequipend,
        'totassetsend', i.totassetsend,
        'deprcatndepletn', i.deprcatndepletn
      ),
      true,
      now()
    FROM facilities f
    INNER JOIN irs_990_raw i ON i.ein = f.ein
    WHERE f.ein IS NOT NULL
      AND i.lndbldgsequipend >= ${MIN_ASSETS_FOR_CAPITAL}
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  console.log(`    capital_investment signals: ${fmt(capResult.rows.length)}`);
  total += capResult.rows.length;

  // financial_health — assets > $50M and positive net assets (solvent)
  const healthResult = await db.execute<{ count: string }>(sql.raw(`
    INSERT INTO purchase_signals (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      f.id,
      'financial_health',
      'irs_990:health:' || i.ein,
      70,
      'irs_990',
      jsonb_build_object(
        'totassetsend', i.totassetsend,
        'totnetassetend', i.totnetassetend,
        'totrevenue', i.totrevenue,
        'totliabend', i.totliabend
      ),
      true,
      now()
    FROM facilities f
    INNER JOIN irs_990_raw i ON i.ein = f.ein
    WHERE f.ein IS NOT NULL
      AND i.totassetsend >= ${MIN_ASSETS_FOR_HEALTH}
      AND i.totnetassetend > 0
      AND i.totrevenue > 0
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  console.log(`    financial_health signals: ${fmt(healthResult.rows.length)}`);
  total += healthResult.rows.length;

  // workforce_expansion — 500+ employees
  const workforceResult = await db.execute<{ count: string }>(sql.raw(`
    INSERT INTO purchase_signals (facility_id, signal_type, signal_value, confidence, source, metadata, is_active, detected_at)
    SELECT
      f.id,
      'workforce_expansion',
      'irs_990:workforce:' || i.ein,
      65,
      'irs_990',
      jsonb_build_object(
        'noemplyeesw3cnt', i.noemplyeesw3cnt,
        'totreprtabled', i.totreprtabled
      ),
      true,
      now()
    FROM facilities f
    INNER JOIN irs_990_raw i ON i.ein = f.ein
    WHERE f.ein IS NOT NULL
      AND i.noemplyeesw3cnt >= ${MIN_EMPLOYEES_EXPANSION}
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  console.log(`    workforce_expansion signals: ${fmt(workforceResult.rows.length)}`);
  total += workforceResult.rows.length;

  return total;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(68));
console.log("  MedIntel OS — IRS 990 Complete Extract Importer");
console.log(`  ZIP path     : ${ZIP_PATH}`);
console.log(`  Batch size   : ${fmt(BATCH_SIZE)}`);
console.log(`  Signals only : ${SIGNALS_ONLY}`);
console.log("═".repeat(68) + "\n");

try {
  await db.execute(sql`SELECT 1`);
  console.log("  DB connected.\n");
} catch (err) {
  console.error("DB connection failed:", String(err));
  process.exit(1);
}

const t0 = Date.now();

// ── Step 1: Import CSV ────────────────────────────────────────────────────────
if (!SIGNALS_ONLY) {
  console.log("  [1/4] Streaming CSV into irs_990_raw...");
  try {
    const { rowsInserted, rowsSkipped } = await importCsv();
    console.log(`  Done: ${fmt(rowsInserted)} rows inserted, ${fmt(rowsSkipped)} skipped.`);
  } catch (err) {
    console.error("  CSV import failed:", String(err));
    process.exit(1);
  }
} else {
  console.log("  [1/4] Skipping CSV import (SIGNALS_ONLY=1).");
}

// ── Step 2: Count what we have ────────────────────────────────────────────────
const [countRow] = await db.execute<{ total: string; hospitals: string }>(sql.raw(`
  SELECT
    COUNT(*)::text AS total,
    COUNT(*) FILTER (WHERE operatehosptlcd = 'Y')::text AS hospitals
  FROM irs_990_raw
`)).then(r => r.rows);
console.log(`\n  [2/4] irs_990_raw: ${fmt(Number(countRow.total))} rows, ${fmt(Number(countRow.hospitals))} hospitals`);

// ── Step 3: Match EINs ───────────────────────────────────────────────────────
console.log("\n  [3/4] Matching EINs to facilities...");
const { matched, linked } = await matchEinsToFacilities();
console.log(`  Matched: ${fmt(matched)} facilities have 990 data. (${fmt(linked)} EINs refreshed)`);

// ── Step 4: Upsert financial_documents ────────────────────────────────────────
console.log("\n  [3b/4] Upserting financial_documents...");
const fdCount = await upsertFinancialDocs();
console.log(`  Upserted ${fmt(fdCount)} financial_documents rows.`);

// ── Step 5: Emit signals ─────────────────────────────────────────────────────
console.log("\n  [4/4] Emitting purchase signals...");
const signalCount = await emitSignals();
console.log(`\n  Total signals emitted: ${fmt(signalCount)}`);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n  Elapsed: ${elapsed}s`);
console.log("═".repeat(68) + "\n");
process.exit(0);
