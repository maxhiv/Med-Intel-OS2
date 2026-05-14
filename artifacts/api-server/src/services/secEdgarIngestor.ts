/**
 * SEC EDGAR ingestor — free public source, no API key required.
 *
 * Searches the EDGAR full-text search index for prospectus and shelf-offering
 * filings (424B3, 424B5, S-1) filed under the facility's health-system parent
 * name within the past year. A debt or equity offering signals that the system
 * has capital available for major equipment purchases — a `bond_issuance`
 * purchase signal.
 *
 * Docs: https://efts.sec.gov/LATEST/search-index (EDGAR EFTS)
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index";
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface EdgarHit {
  _source?: {
    accession_no?: string;
    file_date?: string;
    entity_name?: string;
    form_type?: string;
  };
}

interface EdgarResponse {
  hits?: {
    hits?: EdgarHit[];
    total?: { value?: number };
  };
}

function oneYearAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestSecEdgar(
  opts: { limit?: number } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 500));
  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  const targets = await db
    .select()
    .from(facilities)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      // Prefer the health-system parent name for broader EDGAR match coverage.
      const searchTerm = (f.systemName ?? f.name).split(/[,\-]/)[0].trim();
      const params = new URLSearchParams({
        q: `"${searchTerm}"`,
        forms: "424B3,424B5,S-1",
        dateRange: "custom",
        startdt: oneYearAgo(),
        enddt: today(),
      });
      const res = await fetch(`${EDGAR_SEARCH}?${params}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!res.ok) {
        if (res.status !== 404) result.errors += 1;
        continue;
      }
      const json = (await res.json()) as EdgarResponse;
      const hits = json.hits?.hits ?? [];
      if (hits.length === 0) continue;

      for (const hit of hits.slice(0, 3)) {
        const accession = hit._source?.accession_no;
        if (!accession) continue;

        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, f.id),
              eq(purchaseSignals.signalType, "bond_issuance"),
              eq(purchaseSignals.signalValue, accession),
            ),
          )
          .limit(1);
        if (exists) continue;

        await db.insert(purchaseSignals).values({
          facilityId: f.id,
          signalType: "bond_issuance",
          signalValue: accession,
          confidence: 72,
          source: "sec_edgar",
          isActive: true,
        });
        result.signalsInserted += 1;
      }

      await db
        .update(facilities)
        .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
        .where(eq(facilities.id, f.id));
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "sec_edgar fetch error");
      result.errors += 1;
      continue;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "sec_edgar ingest complete");
  return result;
}
