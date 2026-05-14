/**
 * NPPES NPI Registry bulk import — preloads the `facilities` table from the
 * CMS monthly data dissemination CSV.
 *
 * ─── Download steps ───────────────────────────────────────────────────────
 *
 *   1. Go to https://download.cms.gov/nppes/NPI_Files.html
 *   2. Download the latest "Full Replacement Monthly NPI File" (≈900 MB zip)
 *   3. Unzip it — you'll get `npidata_pfile_YYYYMMDD-YYYYMMDD.csv`
 *
 *   Or use wget/curl:
 *     wget "https://download.cms.gov/nppes/NPPES_Data_Dissemination_May_2026.zip"
 *     unzip NPPES_Data_Dissemination_May_2026.zip 'npidata_pfile_*.csv'
 *
 *   The weekly update files (≈50 MB) also work and only contain recent
 *   additions/changes — useful for incremental refreshes.
 *
 * ─── Run ──────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=postgresql://... \
 *     pnpm --filter @workspace/scripts import-npi -- /path/to/npidata_pfile.csv
 *
 *   Optional flags:
 *     --states TX,CA,FL   Only import facilities in these states (comma-sep)
 *     --limit 50000       Stop after N rows inserted (useful for test runs)
 *     --dry-run           Parse and report counts without writing to DB
 *
 * ─── What gets imported ───────────────────────────────────────────────────
 *
 *   - Entity type 2 (organizations) only — individual providers are skipped
 *   - Active NPIs only — deactivated records are skipped
 *   - US domestic addresses only
 *   - At least one taxonomy code from the IMAGING_FACILITY_TAXONOMIES map
 *
 *   Already-existing NPIs are left unchanged (ON CONFLICT DO NOTHING) so
 *   reruns are safe and won't overwrite manually-enriched records.
 *
 * ─── Performance ──────────────────────────────────────────────────────────
 *
 *   Streams the CSV line-by-line (no full-file memory load), inserts in
 *   batches of 500. A full run on the monthly file (~8 M rows, ~300 K
 *   imaging facilities) typically completes in 10–20 minutes depending on
 *   DB latency.
 */

import fs from "node:fs";
import readline from "node:readline";
import pg from "pg";

const { Pool } = pg;

// ─── Taxonomy code → facility type label ─────────────────────────────────

const IMAGING_FACILITY_TAXONOMIES: Record<string, string> = {
  // Hospitals — all sub-types have imaging departments
  "282N00000X": "Hospital",
  "282NC0060X": "Critical Access Hospital",
  "282NC2000X": "Long Term Care Hospital",
  "282NR1301X": "Rural Hospital",
  "282NW0100X": "Women's Hospital",
  "282E00000X": "Long Term Care Facility",

  // Dedicated imaging / radiology facilities
  "261QR0200X": "Radiology Clinic",
  "261QI0500X": "Imaging Center",
  "261QM1200X": "MRI Center",
  "261QN0025X": "Nuclear Medicine Center",

  // Oncology — often have PET/SPECT/radiation equipment
  "261QX0100X": "Oncology Center",
  "261QX0200X": "Radiation Oncology Center",
  "261QC1500X": "Cancer Center",

  // Ambulatory surgical — frequently have C-arm / fluoroscopy
  "261QS1200X": "Ambulatory Surgical Center",

  // Physician group specialties that operate their own scanners
  "2085R0202X": "Diagnostic Radiology Practice",
  "2085U0001X": "Diagnostic Ultrasound Practice",
  "2085R0001X": "Body Imaging Practice",
  "2085N0700X": "Neuroradiology Practice",
  "2085H0002X": "Magnetic Resonance Imaging (MRI) Practice",
  "207RX0202X": "Medical Oncology Practice",

  // Federally Qualified Health Centers — often have imaging suites
  "261QF0400X": "Federally Qualified Health Center",

  // Veterans / military (large imaging buyer)
  "251G00000X": "Military / DoD Hospital",
  "261QV0200X": "Veterans Affairs Facility",
};

const TAXONOMY_SET = new Set(Object.keys(IMAGING_FACILITY_TAXONOMIES));

// ─── CSV streaming ────────────────────────────────────────────────────────

/**
 * Minimal RFC 4180-compliant CSV row parser.  Handles quoted fields,
 * embedded commas, and doubled-quote escaping ("" → ").
 */
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  return fields;
}

// ─── Column index map (built from the header row) ─────────────────────────

interface ColMap {
  npi: number;
  entityType: number;
  orgName: number;
  otherOrgName: number;
  otherOrgNameType: number;
  deactivationReason: number;
  // Practice location (preferred over mailing)
  pracAddr1: number;
  pracCity: number;
  pracState: number;
  pracZip: number;
  // Mailing (fallback)
  mailAddr1: number;
  mailCity: number;
  mailState: number;
  mailZip: number;
  // Taxonomy codes (_1 through _15), every 4 columns starting at the first
  taxonomyStart: number;
}

function buildColMap(headers: string[]): ColMap {
  const idx = (name: string) => {
    const i = headers.findIndex(
      (h) => h.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase(),
    );
    if (i === -1) throw new Error(`Column not found: "${name}"`);
    return i;
  };

  return {
    npi: idx("NPI"),
    entityType: idx("Entity Type Code"),
    orgName: idx("Provider Organization Name (Legal Business Name)"),
    otherOrgName: idx("Provider Other Organization Name"),
    otherOrgNameType: idx("Provider Other Organization Name Type Code"),
    deactivationReason: idx("NPI Deactivation Reason Code"),
    pracAddr1: idx(
      "Provider First Line Business Practice Location Address",
    ),
    pracCity: idx("Provider Business Practice Location Address City Name"),
    pracState: idx("Provider Business Practice Location Address State Name"),
    pracZip: idx("Provider Business Practice Location Address Postal Code"),
    mailAddr1: idx("Provider First Line Business Mailing Address"),
    mailCity: idx("Provider Business Mailing Address City Name"),
    mailState: idx("Provider Business Mailing Address State Name"),
    mailZip: idx("Provider Business Mailing Address Postal Code"),
    // The first taxonomy code column — subsequent codes are every 4 cols after.
    taxonomyStart: idx("Healthcare Provider Taxonomy Code_1"),
  };
}

// ─── Row extraction ───────────────────────────────────────────────────────

interface FacilityRow {
  npi: string;
  name: string;
  doingBusinessAs: string | null;
  facilityType: string;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

function extractFacility(
  fields: string[],
  col: ColMap,
  stateFilter: Set<string> | null,
): FacilityRow | null {
  // Organizations only
  if (fields[col.entityType] !== "2") return null;
  // Active only (deactivation reason blank = active)
  if (fields[col.deactivationReason]) return null;

  // Collect all taxonomy codes for this row (up to 15, every 4 columns)
  let facilityType: string | null = null;
  for (let t = 0; t < 15; t++) {
    const code = fields[col.taxonomyStart + t * 4]?.trim();
    if (code && TAXONOMY_SET.has(code)) {
      facilityType = IMAGING_FACILITY_TAXONOMIES[code];
      break;
    }
  }
  if (!facilityType) return null;

  // Prefer practice location address; fall back to mailing
  const state =
    (fields[col.pracState] || fields[col.mailState] || "").trim().slice(0, 2).toUpperCase() || null;

  // US domestic only
  if (!state || state.length !== 2) return null;
  if (stateFilter && !stateFilter.has(state)) return null;

  const npi = fields[col.npi]?.trim();
  const name = fields[col.orgName]?.trim();
  if (!npi || !name) return null;

  const otherName = fields[col.otherOrgName]?.trim() || null;
  const otherNameType = fields[col.otherOrgNameType]?.trim();
  // Type code "3" = DBA name
  const dba = otherNameType === "3" && otherName ? otherName : null;

  const addr1 =
    (fields[col.pracAddr1] || fields[col.mailAddr1] || "").trim() || null;
  const city =
    (fields[col.pracCity] || fields[col.mailCity] || "").trim() || null;
  const rawZip =
    (fields[col.pracZip] || fields[col.mailZip] || "").trim() || null;
  const zip = rawZip ? rawZip.slice(0, 10) : null;

  return { npi, name, doingBusinessAs: dba, facilityType, address1: addr1, city, state, zip };
}

// ─── Batch DB upsert ──────────────────────────────────────────────────────

async function flushBatch(
  pool: pg.Pool,
  batch: FacilityRow[],
  dryRun: boolean,
): Promise<number> {
  if (batch.length === 0) return 0;
  if (dryRun) return batch.length;

  // Build a single multi-row INSERT … ON CONFLICT DO NOTHING
  const values: unknown[] = [];
  const placeholders = batch.map((row, i) => {
    const base = i * 8;
    values.push(
      row.npi,
      row.name,
      row.doingBusinessAs,
      row.facilityType,
      row.address1,
      row.city,
      row.state,
      row.zip,
    );
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
  });

  await pool.query(
    `INSERT INTO facilities
       (npi, name, doing_business_as, facility_type, address1, city, state, zip)
     VALUES ${placeholders.join(",")}
     ON CONFLICT (npi) DO NOTHING`,
    values,
  );

  // Link every newly-inserted facility to all existing accounts.
  // ON CONFLICT DO NOTHING makes this safe to run on every batch — facilities
  // that were already linked are skipped without error.
  await pool.query(`
    INSERT INTO account_facilities (account_id, facility_id)
    SELECT a.id, f.id
    FROM accounts a
    CROSS JOIN (
      SELECT id FROM facilities WHERE npi = ANY($1::text[])
    ) f
    ON CONFLICT (account_id, facility_id) DO NOTHING
  `, [batch.map((r) => r.npi)]);

  return batch.length;
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  csvPath: string | null;
  stateFilter: Set<string> | null;
  limit: number;
  dryRun: boolean;
} {
  const args = argv.slice(2);
  let csvPath: string | null = null;
  let stateFilter: Set<string> | null = null;
  let limit = Infinity;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--states" && args[i + 1]) {
      stateFilter = new Set(args[++i].split(",").map((s) => s.trim().toUpperCase()));
    } else if (a === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (!a.startsWith("--")) {
      csvPath = a;
    }
  }

  return { csvPath, stateFilter, limit, dryRun };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { csvPath, stateFilter, limit, dryRun } = parseArgs(process.argv);

  if (!csvPath) {
    console.error(`
Usage: DATABASE_URL=postgresql://... pnpm --filter @workspace/scripts import-npi -- <path-to-npi.csv> [options]

Options:
  --states TX,CA,FL    Only import facilities in these states
  --limit 10000        Stop after N facilities inserted
  --dry-run            Parse without writing to the database

How to get the NPI CSV:
  1. Visit https://download.cms.gov/nppes/NPI_Files.html
  2. Download the "Full Replacement Monthly NPI File" (≈900 MB zip)
  3. Unzip: unzip NPPES_Data_Dissemination_*.zip 'npidata_pfile_*.csv'
  4. Run this script pointing at the unzipped CSV.

  For incremental refreshes download the "Weekly Update" file instead.
`);
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set");
    process.exit(1);
  }

  const pool = dryRun
    ? null
    : new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

  console.log(`→ Streaming ${csvPath}`);
  if (stateFilter) console.log(`  States: ${[...stateFilter].join(", ")}`);
  if (limit !== Infinity) console.log(`  Limit: ${limit}`);
  if (dryRun) console.log("  DRY RUN — no DB writes");

  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let col: ColMap | null = null;
  const BATCH_SIZE = 500;
  let batch: FacilityRow[] = [];
  let totalInserted = 0;
  let totalScanned = 0;
  let totalSkipped = 0;
  const start = Date.now();

  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) {
      // Header row — build column index map
      const headers = parseRow(line);
      try {
        col = buildColMap(headers);
      } catch (err) {
        console.error(`Header parsing failed: ${err}`);
        process.exit(1);
      }
      console.log(`  Header parsed — ${headers.length} columns detected`);
      continue;
    }

    if (!col) continue;
    totalScanned++;

    const fields = parseRow(line);
    const row = extractFacility(fields, col, stateFilter);

    if (!row) {
      totalSkipped++;
      continue;
    }

    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      totalInserted += await flushBatch(pool!, batch, dryRun);
      batch = [];

      if (totalInserted >= limit) {
        console.log(`  Limit of ${limit} reached — stopping`);
        break;
      }

      if (totalInserted % 10_000 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const rate = Math.round(totalScanned / +elapsed);
        console.log(
          `  ${totalInserted.toLocaleString()} inserted | ` +
          `${totalScanned.toLocaleString()} scanned | ` +
          `${elapsed}s elapsed | ${rate.toLocaleString()} rows/s`,
        );
      }
    }
  }

  // Flush remainder
  if (batch.length > 0) {
    totalInserted += await flushBatch(pool!, batch, dryRun);
  }

  await pool?.end();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`
✅ Done in ${elapsed}s
   Rows scanned:  ${totalScanned.toLocaleString()}
   Rows skipped:  ${totalSkipped.toLocaleString()}
   Rows inserted: ${totalInserted.toLocaleString()}${dryRun ? " (dry run)" : ""}
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
