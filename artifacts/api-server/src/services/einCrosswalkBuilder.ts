/**
 * IRS Business Master File (BMF) Crosswalk Builder
 *
 * Downloads the IRS EO BMF files (4 regional CSVs, ~50MB total) and matches
 * healthcare-related nonprofits (NTEE codes starting with E, F, G, H) against
 * our facilities using a 3-layer strategy:
 *
 *   Layer 1: facilities.ein exact match (if already populated)
 *   Layer 2: pg_trgm similarity on facilities.systemName (system-level filer)
 *   Layer 3: pg_trgm similarity on facilities.name / doingBusinessAs
 *
 * Results are stored in ein_crosswalk. This crosswalk is then used by the
 * IRS 990 EOI bulk ingestor for fast EIN lookups instead of per-row name matching.
 *
 * Source: https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 * No API key required.
 */
import { sql, eq, and, isNull } from "drizzle-orm";
import { db, facilities, einCrosswalk } from "@workspace/db";
import { logger } from "../lib/logger";

const BMF_URLS = [
  "https://www.irs.gov/pub/irs-soi/eo1.csv",
  "https://www.irs.gov/pub/irs-soi/eo2.csv",
  "https://www.irs.gov/pub/irs-soi/eo3.csv",
  "https://www.irs.gov/pub/irs-soi/eo4.csv",
];

// Only healthcare-adjacent NTEE major groups
const HEALTHCARE_NTEE_PREFIXES = ["E", "F", "G", "H"];

const FETCH_TIMEOUT_MS = 60_000;
const DELAY_MS = 10;
const TRGM_THRESHOLD = 0.35;

export interface BmfIngestResult {
  bmfRowsRead: number;
  healthcareOrgs: number;
  crosswalkEntries: number;
  errors: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fetchWithTimeout(url: string): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: ac.signal,
    headers: {
      "User-Agent": `MedIntelOS ${process.env.PLATFORM_ADMIN_EMAIL ?? "research@medintel.ai"}`,
    },
  }).finally(() => clearTimeout(t));
}

interface BmfRow {
  ein: string;
  name: string;
  city: string;
  state: string;
  nteeCode: string;
}

async function parseBmfCsv(url: string, onRow: (row: BmfRow) => Promise<void>): Promise<number> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`BMF fetch failed: ${res.status} ${url}`);

  const text = await res.text();
  const lines = text.split("\n");
  let rowsRead = 0;

  // BMF header: EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,
  //             CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,
  //             STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,
  //             ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME
  // We only need EIN(0), NAME(1), CITY(4), STATE(5), NTEE_CD(26)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 27) continue;

    const ein = cols[0]?.trim().replace(/\D/g, "").padStart(9, "0");
    const name = cols[1]?.trim().replace(/^"|"$/g, "") ?? "";
    const city = cols[4]?.trim() ?? "";
    const state = cols[5]?.trim().toUpperCase() ?? "";
    const nteeCode = cols[26]?.trim() ?? "";

    if (!ein || !name || ein.length !== 9) continue;

    // Filter to healthcare NTEE codes
    if (!HEALTHCARE_NTEE_PREFIXES.some((p) => nteeCode.toUpperCase().startsWith(p))) continue;

    rowsRead++;
    await onRow({ ein, name, city, state, nteeCode });
  }
  return rowsRead;
}

async function findFacilityMatches(
  row: BmfRow,
): Promise<Array<{ facilityId: string; matchType: string; score: number }>> {
  const results: Array<{ facilityId: string; matchType: string; score: number }> = [];

  // Layer 1: exact EIN match
  const einMatches = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.ein, row.ein))
    .limit(20);
  for (const m of einMatches) {
    results.push({ facilityId: m.id, matchType: "ein_exact", score: 1.0 });
  }
  if (results.length > 0) return results;

  // Layer 2: trigram similarity on systemName (catches system-level filers)
  // matches ALL facilities in the system
  if (row.name.length >= 4) {
    const sysMatches = await db.execute<{ id: string; score: number }>(
      sql`SELECT id, similarity(system_name, ${row.name}) as score
          FROM facilities
          WHERE system_name IS NOT NULL
            AND (${row.state} = '' OR state = ${row.state})
            AND similarity(system_name, ${row.name}) > ${TRGM_THRESHOLD}
          ORDER BY score DESC
          LIMIT 30`,
    );
    for (const m of sysMatches.rows) {
      if (m.score >= TRGM_THRESHOLD) {
        results.push({ facilityId: m.id, matchType: "system_name", score: Number(m.score) });
      }
    }
    if (results.length > 0) return results;
  }

  // Layer 3: trigram similarity on facility name or DBA
  const nameMatches = await db.execute<{ id: string; score: number }>(
    sql`SELECT id,
          GREATEST(
            similarity(name, ${row.name}),
            COALESCE(similarity(doing_business_as, ${row.name}), 0)
          ) as score
        FROM facilities
        WHERE (${row.state} = '' OR state = ${row.state})
          AND (
            similarity(name, ${row.name}) > ${TRGM_THRESHOLD}
            OR similarity(doing_business_as, ${row.name}) > ${TRGM_THRESHOLD}
          )
        ORDER BY score DESC
        LIMIT 5`,
  );
  for (const m of nameMatches.rows) {
    if (m.score >= TRGM_THRESHOLD) {
      results.push({ facilityId: m.id, matchType: "facility_name", score: Number(m.score) });
    }
  }

  return results;
}

export async function buildEinCrosswalk(
  opts: { states?: string[]; nteeFilter?: string[] } = {},
): Promise<BmfIngestResult> {
  const result: BmfIngestResult = {
    bmfRowsRead: 0,
    healthcareOrgs: 0,
    crosswalkEntries: 0,
    errors: 0,
  };
  const targetStates = new Set(opts.states?.map((s) => s.toUpperCase()) ?? []);

  for (const url of BMF_URLS) {
    try {
      logger.info({ url }, "downloading BMF file");
      const rowsRead = await parseBmfCsv(url, async (row) => {
        result.bmfRowsRead++;

        // State filter
        if (targetStates.size > 0 && row.state && !targetStates.has(row.state)) return;

        result.healthcareOrgs++;
        try {
          const matches = await findFacilityMatches(row);
          for (const match of matches) {
            await db
              .insert(einCrosswalk)
              .values({
                ein: row.ein,
                facilityId: match.facilityId,
                entityName: row.name.slice(0, 200),
                entityCity: row.city || null,
                entityState: row.state.slice(0, 2) || null,
                nteeCode: row.nteeCode || null,
                matchType: match.matchType,
                matchScore: String(match.score),
              })
              .onConflictDoNothing();

            // Back-fill facilities.ein if this was an exact match or high-confidence name match
            if (match.matchType === "ein_exact" || match.score >= 0.8) {
              await db
                .update(facilities)
                .set({
                  ein: row.ein,
                  einSource: `bmf_${match.matchType}`,
                  updatedAt: new Date(),
                })
                .where(and(eq(facilities.id, match.facilityId), isNull(facilities.ein)));
            }
            result.crosswalkEntries++;
          }
        } catch (err) {
          logger.warn({ err, ein: row.ein }, "BMF crosswalk match error");
          result.errors++;
        }
        await sleep(DELAY_MS);
      });
      logger.info({ url, rowsRead }, "BMF file processed");
    } catch (err) {
      logger.error({ err, url }, "BMF file download error");
      result.errors++;
    }
  }

  logger.info(result, "ein_crosswalk build complete");
  return result;
}
