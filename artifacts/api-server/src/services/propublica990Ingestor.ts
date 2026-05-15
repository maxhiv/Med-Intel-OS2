/**
 * ProPublica Nonprofit Explorer 990 ingestor — free public source, no API key required.
 *
 * For each tracked facility we search the ProPublica Nonprofit Explorer API
 * by facility name + state. When a matching nonprofit EIN is found we pull its
 * 990 filing history and:
 *
 *   1. Emit `fiscal_year_end` signals (close of a fiscal year is an opportune
 *      moment for capital procurement).
 *   2. Emit `grant_awarded` signals when contributions > $1M.
 *   3. Extract CFO / COO / VP Finance / CEO officers from the filing's
 *      Part VII data and upsert them into facility_contacts (confidence 70,
 *      buyingAuthorityScore per CMX spec: CFO/COO=85, VP Finance=75, CEO=70).
 *
 * Docs: https://projects.propublica.org/nonprofits/api/v2
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals, facilityContacts } from "@workspace/db";
import { logger } from "../lib/logger";

const PP_SEARCH = "https://projects.propublica.org/nonprofits/api/v2/search.json";
const PP_ORG = "https://projects.propublica.org/nonprofits/api/v2/organizations";
const DELAY_MS = 1100;
const GRANT_THRESHOLD = 1_000_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PpSearchResult {
  organizations?: { ein?: number; name?: string; state?: string }[];
}

interface PpFiling {
  tax_prd_yr?: number;
  tax_prd?: string;
  totcntrbgfts?: number;
  totfuncexpns?: number;
  // Part VII officer fields — ProPublica returns up to 10 principals per filing
  principalname0?: string;  principaltitle0?: string;
  principalname1?: string;  principaltitle1?: string;
  principalname2?: string;  principaltitle2?: string;
  principalname3?: string;  principaltitle3?: string;
  principalname4?: string;  principaltitle4?: string;
  principalname5?: string;  principaltitle5?: string;
  principalname6?: string;  principaltitle6?: string;
  principalname7?: string;  principaltitle7?: string;
  principalname8?: string;  principaltitle8?: string;
  principalname9?: string;  principaltitle9?: string;
}

interface PpOrg {
  organization?: { ein?: number; name?: string };
  filings_with_data?: PpFiling[];
}

// ── Officer title → buying authority score ────────────────────────────────────

const TITLE_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /\bCFO\b|\bchief financial\b/i,             score: 85 },
  { pattern: /\bCOO\b|\bchief operating\b/i,              score: 85 },
  { pattern: /\bVP\s+Finance\b|\bVice Pres.*Finance\b/i,  score: 75 },
  { pattern: /\bCEO\b|\bchief exec\b/i,                   score: 70 },
];

function buyingScoreForTitle(title: string): number | null {
  for (const { pattern, score } of TITLE_PATTERNS) {
    if (pattern.test(title)) return score;
  }
  return null;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

async function upsertOfficerContacts(
  facilityId: string,
  filing: PpFiling,
): Promise<number> {
  let upserted = 0;
  for (let i = 0; i < 10; i++) {
    const name  = (filing as Record<string, unknown>)[`principalname${i}`] as string | undefined;
    const title = (filing as Record<string, unknown>)[`principaltitle${i}`] as string | undefined;
    if (!name || !title) continue;

    const score = buyingScoreForTitle(title);
    if (!score) continue;

    const { firstName, lastName } = splitName(name);
    if (!lastName) continue;

    const existing = await db
      .select({
        id: facilityContacts.id,
        buyingAuthorityScore: facilityContacts.buyingAuthorityScore,
      })
      .from(facilityContacts)
      .where(
        and(
          eq(facilityContacts.facilityId, facilityId),
          sql`lower(${facilityContacts.firstName}) = lower(${firstName})`,
          sql`lower(${facilityContacts.lastName}) = lower(${lastName})`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const currentScore = existing[0].buyingAuthorityScore ?? 0;
      if (score > currentScore) {
        await db
          .update(facilityContacts)
          .set({ buyingAuthorityScore: score, title, confidenceScore: 70, updatedAt: new Date() })
          .where(eq(facilityContacts.id, existing[0].id));
        upserted++;
      }
    } else {
      await db.insert(facilityContacts).values({
        facilityId,
        firstName,
        lastName,
        title,
        buyingAuthorityScore: score,
        confidenceScore: 70,
        dataSource: "irs_990",
      });
      upserted++;
    }
  }
  return upserted;
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  contactsUpserted: number;
  errors: number;
}

export async function ingestPropublica990(
  opts: { limit?: number; states?: string[] } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 500));
  const stateFilter = opts.states?.length
    ? inArray(facilities.state, opts.states)
    : sql`${facilities.state} IS NOT NULL`;
  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    contactsUpserted: 0,
    errors: 0,
  };

  const targets = await db
    .select()
    .from(facilities)
    .where(stateFilter)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  for (const f of targets) {
    result.facilitiesScanned += 1;
    let ein: number | undefined;

    try {
      const shortName = f.name.split(/[,\-]/)[0].trim().slice(0, 60);
      const searchParams = new URLSearchParams({ q: shortName });
      if (f.state) searchParams.set("state[id]", f.state);

      const searchRes = await fetch(`${PP_SEARCH}?${searchParams}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntelOS research@medintel.ai" },
      });
      if (!searchRes.ok) {
        result.errors += 1;
        await sleep(DELAY_MS);
        continue;
      }
      const searchJson = (await searchRes.json()) as PpSearchResult;
      const orgs = searchJson.organizations ?? [];
      if (orgs.length === 0) continue;

      ein = orgs[0].ein;
      if (!ein) continue;

      await sleep(150);

      const orgRes = await fetch(`${PP_ORG}/${ein}.json`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntelOS research@medintel.ai" },
      });
      if (!orgRes.ok) {
        if (orgRes.status !== 404) result.errors += 1;
        await sleep(DELAY_MS);
        continue;
      }
      const orgJson = (await orgRes.json()) as PpOrg;
      const filings = orgJson.filings_with_data ?? [];
      if (filings.length === 0) continue;

      for (const filing of filings.slice(0, 3)) {
        const year = filing.tax_prd_yr;
        if (!year) continue;

        // Fiscal year end signal.
        const fyValue = `pp990:${ein}:${year}`;
        const [fyExists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, f.id),
              eq(purchaseSignals.signalType, "fiscal_year_end"),
              eq(purchaseSignals.signalValue, fyValue),
            ),
          )
          .limit(1);
        if (!fyExists) {
          await db.insert(purchaseSignals).values({
            facilityId: f.id,
            signalType: "fiscal_year_end",
            signalValue: fyValue,
            confidence: 70,
            source: "propublica_990",
            metadata: null,
            isActive: true,
          });
          result.signalsInserted += 1;
        }

        // Write fiscal year end month if not already set from a higher-priority
        // source (hcris is higher priority; irs_990 only fills the gap).
        const taxPrdStr = filing.tax_prd != null ? String(filing.tax_prd) : "";
        const fyeMonthFromPeriod = taxPrdStr.length >= 2
          ? parseInt(taxPrdStr.slice(-2), 10)
          : undefined;
        const fyeMonth = fyeMonthFromPeriod;
        if (fyeMonth && fyeMonth >= 1 && fyeMonth <= 12) {
          await db
            .update(facilities)
            .set({ fiscalYearEndMonth: fyeMonth, fiscalYearEndSource: "irs_990", updatedAt: new Date() })
            .where(
              sql`${facilities.id} = ${f.id} AND ${facilities.fiscalYearEndSource} IS NULL`,
            );
        }

        // Large-grants signal.
        const grants = filing.totcntrbgfts ?? 0;
        if (grants >= GRANT_THRESHOLD) {
          const grantValue = `pp990:grant:${ein}:${year}`;
          const [grantExists] = await db
            .select({ id: purchaseSignals.id })
            .from(purchaseSignals)
            .where(
              and(
                eq(purchaseSignals.facilityId, f.id),
                eq(purchaseSignals.signalType, "grant_awarded"),
                eq(purchaseSignals.signalValue, grantValue),
              ),
            )
            .limit(1);
          if (!grantExists) {
            await db.insert(purchaseSignals).values({
              facilityId: f.id,
              signalType: "grant_awarded",
              signalValue: grantValue,
              confidence: 65,
              source: "propublica_990",
              metadata: null,
              isActive: true,
            });
            result.signalsInserted += 1;
          }
        }

        // Phase 9 — extract CFO/COO/VP Finance/CEO from most-recent filing only.
        if (filing === filings[0]) {
          const cnt = await upsertOfficerContacts(f.id, filing);
          result.contactsUpserted += cnt;
        }
      }

      await db
        .update(facilities)
        .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
        .where(eq(facilities.id, f.id));
    } catch (err) {
      logger.warn({ err, facilityId: f.id, ein }, "propublica_990 fetch error");
      result.errors += 1;
      continue;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "propublica_990 ingest complete");
  return result;
}
