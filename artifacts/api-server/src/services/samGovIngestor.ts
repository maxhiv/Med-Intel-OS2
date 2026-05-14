/**
 * SAM.gov Federal Procurement Ingestor
 *
 * Monitors federal RFP opportunities for medical imaging equipment (NAICS
 * 334517 / 334510) and emits `rfp_posted` purchase signals.
 *
 * Requires env var: SAM_GOV_API_KEY (free registration at api.sam.gov).
 * If not set, logs a warning and returns zero counts — never fails hard.
 *
 * Docs: https://open.gsa.gov/api/opportunities-api/
 */
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const BASE_URL = "https://api.sam.gov/opportunities/v2/search";
const NAICS_CODES = ["334517", "334510"];
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SamIngestResult {
  signalsInserted: number;
  errors: number;
}

interface SamOpportunity {
  noticeId?: string;
  title?: string;
  postedDate?: string;
  responseDeadLine?: string;
  organizationName?: string;
  placeOfPerformanceCityName?: string;
  placeOfPerformanceState?: { code?: string };
  naicsCode?: string;
  description?: string;
  uiLink?: string;
}

interface SamResponse {
  opportunitiesData?: SamOpportunity[];
  totalRecords?: number;
}

async function matchFacility(orgName: string | undefined): Promise<string | null> {
  if (!orgName) return null;
  const name = orgName.trim();
  if (!name) return null;
  const [match] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      or(
        ilike(facilities.name, `%${name}%`),
        ilike(facilities.doingBusinessAs, `%${name}%`),
        ilike(facilities.systemName, `%${name}%`),
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

export async function ingestSamGov(
  opts: { limit?: number } = {},
): Promise<SamIngestResult> {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    logger.warn("SAM_GOV_API_KEY not set — skipping SAM.gov ingest");
    return { signalsInserted: 0, errors: 0 };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: SamIngestResult = { signalsInserted: 0, errors: 0 };

  for (const naics of NAICS_CODES) {
    const params = new URLSearchParams({
      api_key: apiKey,
      naicsCode: naics,
      typeOfSetAsideDescription: "",
      ntype: "o",
      status: "Active",
      limit: String(limit),
      offset: "0",
    });

    try {
      const res = await fetch(`${BASE_URL}?${params}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!res.ok) {
        logger.warn({ status: res.status, naics }, "sam.gov API error");
        result.errors += 1;
        continue;
      }
      const body = (await res.json()) as SamResponse;
      const opps = body.opportunitiesData ?? [];

      for (const opp of opps) {
        if (!opp.noticeId) continue;

        const signalValue = `sam:${opp.noticeId}`;
        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.signalType, "rfp_posted"),
              eq(purchaseSignals.signalValue, signalValue),
            ),
          )
          .limit(1);
        if (exists) continue;

        const facilityId = await matchFacility(opp.organizationName);

        if (facilityId) {
          await db.insert(purchaseSignals).values({
            facilityId,
            signalType: "rfp_posted",
            signalValue,
            confidence: 80,
            source: "sam_gov",
            isActive: true,
          });
          result.signalsInserted += 1;
        }

        await sleep(DELAY_MS);
      }
    } catch (err) {
      logger.warn({ err, naics }, "sam.gov ingest error");
      result.errors += 1;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "sam_gov ingest complete");
  return result;
}
