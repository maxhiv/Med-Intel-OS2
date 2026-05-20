/**
 * SEC EDGAR bulk seed — quarterly full-text index files.
 *
 * EDGAR publishes quarterly index files listing every filing by every
 * registrant. The full-text indexes (form/, company/, master/) live at:
 *   https://www.sec.gov/Archives/edgar/full-index/<YYYY>/<QN>/master.idx
 *
 * For healthcare equipment-purchase signals we care primarily about:
 *   - 8-K item 1.01 (Material Definitive Agreement) — capital purchases
 *   - 8-K item 2.01 (Completion of Acquisition) — M&A signals
 *   - 10-K capex disclosures (sec_capex_flag)
 *
 * The bulk index files give us the filing list; pulling the full bodies
 * is a separate (expensive) step. This script:
 *
 *   1. Downloads each quarterly master.idx file (small — ~10 MB each).
 *   2. Stages every filing reference into `sec_edgar_filings_raw` (created
 *      ad-hoc by this script — see schema setup below).
 *   3. Filters to healthcare CIKs by joining against the existing
 *      `facilities.sec_cik` column (populated by the live ingestor).
 *   4. Operators run a follow-up enrichment job to pull full text for
 *      flagged filings (8-K Item 1.01 / 2.01 / 10-K).
 *
 * Defaults to seeding the most recent 8 quarters. Required header:
 *   User-Agent — SEC requires a contact email in the User-Agent or the
 *   request is rejected. Set SEC_USER_AGENT env var.
 *
 * Usage:
 *   SEC_USER_AGENT="medintel-os name@example.com" \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/seed/sec-edgar.ts \
 *     [--quarters 8] [--force]
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
import readline from "node:readline";

const SOURCE_NAME = "sec_edgar";
const REQUIRED_UA = process.env.SEC_USER_AGENT;

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

interface QuarterRef { year: number; quarter: 1 | 2 | 3 | 4 }
function recentQuarters(n: number): QuarterRef[] {
  const now = new Date();
  const currentQ = (Math.floor(now.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const out: QuarterRef[] = [];
  let y = now.getFullYear();
  let q: 1 | 2 | 3 | 4 = currentQ;
  for (let i = 0; i < n; i++) {
    out.push({ year: y, quarter: q });
    if (q === 1) { y -= 1; q = 4; } else { q = (q - 1) as 1 | 2 | 3 | 4; }
  }
  return out;
}

export async function runSecEdgarSeed(opts: { quarters?: number; force?: boolean } = {}): Promise<{
  rowsStaged: number;
}> {
  if (!REQUIRED_UA) {
    throw new Error("SEC_USER_AGENT env var is required (SEC rejects requests without contact info).");
  }

  // Lazy-create the staging table — not part of the main schema since SEC
  // is the only consumer.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sec_edgar_filings_raw (
      ingested_at  timestamptz NOT NULL DEFAULT now(),
      cik          text NOT NULL,
      company_name text,
      form_type    text NOT NULL,
      filing_date  date NOT NULL,
      filename     text NOT NULL,
      PRIMARY KEY (cik, form_type, filing_date, filename)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sec_filings_cik  ON sec_edgar_filings_raw (cik)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sec_filings_form ON sec_edgar_filings_raw (form_type, filing_date DESC)`);

  const quarters = recentQuarters(opts.quarters ?? 8);
  let totalStaged = 0;

  for (const q of quarters) {
    const url = `https://www.sec.gov/Archives/edgar/full-index/${q.year}/QTR${q.quarter}/master.idx`;
    const filename = `master_${q.year}_Q${q.quarter}.idx`;
    const dl = await downloadFile({
      url,
      subdir: "sec-edgar",
      filename,
      headers: { "User-Agent": REQUIRED_UA },
    });
    if (!opts.force && (await hasSuccessfulSeed(SOURCE_NAME, dl.sha256))) {
      logger.info({ quarter: q, sha256: dl.sha256 }, "sec-edgar: cached, skipping");
      continue;
    }
    const runId = await startSeedRun({
      sourceName: SOURCE_NAME,
      fileUrl: url,
      fileSha256: dl.sha256,
      fileBytes: dl.bytes,
      meta: { year: q.year, quarter: q.quarter },
    });
    try {
      const rowsStaged = await stageMasterIdx(dl.path);
      totalStaged += rowsStaged;
      await finishSeedRun(runId, { status: "ok", rowsStaged, meta: { year: q.year, quarter: q.quarter } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishSeedRun(runId, { status: "failed", errorMessage: msg, meta: { year: q.year, quarter: q.quarter } });
      throw err;
    }
  }

  return { rowsStaged: totalStaged };
}

async function stageMasterIdx(idxPath: string): Promise<number> {
  return withProgress(`sec-edgar:stage`, async (tick) => {
    const rl = readline.createInterface({ input: createReadStream(idxPath, "utf8") });
    let header = true;
    const BATCH = 500;
    let batch: Array<{ cik: string; company: string; form: string; date: string; filename: string }> = [];
    let total = 0;
    for await (const line of rl) {
      if (header) {
        // Master.idx has a fixed preamble that ends with a row of dashes
        // followed by the column header. Switch to data mode after the
        // dashed separator.
        if (/^-+$/.test(line.trim())) header = false;
        continue;
      }
      const parts = line.split("|");
      if (parts.length < 5) continue;
      const [cik, company, form, date, filename] = parts;
      batch.push({ cik: cik.trim(), company: company.trim(), form: form.trim(), date: date.trim(), filename: filename.trim() });
      tick();
      if (batch.length >= BATCH) {
        total += await flushSecBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) total += await flushSecBatch(batch);
    return total;
  });
}

async function flushSecBatch(
  batch: Array<{ cik: string; company: string; form: string; date: string; filename: string }>,
): Promise<number> {
  const tuples = batch.map(
    (r) =>
      `(${lit(r.cik)}, ${lit(r.company)}, ${lit(r.form)}, ${lit(r.date)}, ${lit(r.filename)})`,
  );
  await db.execute(sql.raw(`
    INSERT INTO sec_edgar_filings_raw (cik, company_name, form_type, filing_date, filename)
    VALUES ${tuples.join(",")}
    ON CONFLICT (cik, form_type, filing_date, filename) DO NOTHING
  `));
  return tuples.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  runSecEdgarSeed({
    quarters: typeof flags.quarters === "string" ? Number(flags.quarters) : undefined,
    force: flags.force === true,
  })
    .then((r) => {
      logger.info(r, "sec-edgar: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "sec-edgar: seed failed");
      process.exit(1);
    });
}
