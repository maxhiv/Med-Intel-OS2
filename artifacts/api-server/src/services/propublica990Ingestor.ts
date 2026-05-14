/**
 * ProPublica Nonprofit Explorer 990 ingestor — free public source, no API key required.
 *
 * For each tracked facility we search the ProPublica Nonprofit Explorer API
 * by facility name + state. When a matching nonprofit EIN is found we pull its
 * 990 filing history. Each fiscal-year 990 filing is emitted as a
 * `fiscal_year_end` signal (the close of a fiscal year is an opportune moment
 * for capital procurement). Filings with substantial contributions/grants
 * (> $1M) also emit a `grant_awarded` signal.
 *
 * Docs: https://projects.propublica.org/nonprofits/api/v2
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const PP_SEARCH = "https://projects.propublica.org/nonprofits/api/v2/search.json";
const PP_ORG = "https://projects.propublica.org/nonprofits/api/v2/organizations";
const DELAY_MS = 300;
const GRANT_THRESHOLD = 1_000_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PpSearchResult {
  organizations?: { ein?: number; name?: string; state?: string }[];
}

interface PpFiling {
  tax_prd_yr?: number;
  totcntrbgfts?: number;
  totfuncexpns?: number;
}

interface PpOrg {
  organization?: { ein?: number; name?: string };
  filings_with_data?: PpFiling[];
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestPropublica990(
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
    .where(sql`${facilities.state} IS NOT NULL`)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  for (const f of targets) {
    result.facilitiesScanned += 1;
    let ein: number | undefined;

    try {
      // Step 1 — find the EIN by searching for the facility name.
      const shortName = f.name.split(/[,\-]/)[0].trim().slice(0, 60);
      const searchParams = new URLSearchParams({ q: shortName });
      if (f.state) searchParams.set("state[id]", f.state);

      const searchRes = await fetch(`${PP_SEARCH}?${searchParams}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!searchRes.ok) {
        result.errors += 1;
        continue;
      }
      const searchJson = (await searchRes.json()) as PpSearchResult;
      const orgs = searchJson.organizations ?? [];
      if (orgs.length === 0) continue; // Not found — skip silently, not an error.

      ein = orgs[0].ein;
      if (!ein) continue;

      await sleep(150);

      // Step 2 — fetch org details and 990 filings.
      const orgRes = await fetch(`${PP_ORG}/${ein}.json`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!orgRes.ok) {
        if (orgRes.status !== 404) result.errors += 1;
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
            isActive: true,
          });
          result.signalsInserted += 1;
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
              isActive: true,
            });
            result.signalsInserted += 1;
          }
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
