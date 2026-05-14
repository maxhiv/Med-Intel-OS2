/**
 * Medicare Provider Utilization Ingestor
 *
 * Pulls high-volume imaging providers from the CMS Medicare Provider Utilization
 * and Payment Data API. Facilities with > 2,000 imaging services/year receive
 * a `high_utilization` signal, indicating active imaging equipment demand.
 *
 * Source: https://data.cms.gov/provider-summary-by-type-of-service/
 * No API key required.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const CMS_API =
  "https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/medicare-physician-other-practitioners-by-provider-and-service/api/1/datastore/query";

// High-volume imaging HCPCS codes
const IMAGING_HCPCS = ["70553", "71250", "78816", "77067", "70470"];
const MIN_SERVICES = 2_000;
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface MedicareUtilIngestResult {
  signalsInserted: number;
  errors: number;
}

interface CmsRecord {
  Rndrng_NPI?: string;
  Rndrng_Prvdr_Org_Name?: string;
  Rndrng_Prvdr_City?: string;
  Rndrng_Prvdr_State_Abrvtn?: string;
  HCPCS_Cd?: string;
  Tot_Srvcs?: number | string;
  Tot_Benes?: number | string;
}

interface CmsResponse {
  data?: CmsRecord[];
  meta?: { count?: number };
}

async function matchFacilityByNpi(npi: string): Promise<string | null> {
  const [match] = await db
    .select({ id: facilities.id, signalScore: facilities.signalScore })
    .from(facilities)
    .where(eq(facilities.npi, npi))
    .limit(1);
  return match?.id ?? null;
}

export async function ingestMedicareUtil(
  opts: { limit?: number } = {},
): Promise<MedicareUtilIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: MedicareUtilIngestResult = { signalsInserted: 0, errors: 0 };

  for (const hcpcs of IMAGING_HCPCS) {
    try {
      const res = await fetch(CMS_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "MedIntel/1.0",
        },
        body: JSON.stringify({
          conditions: [
            { property: "HCPCS_Cd", value: hcpcs, operator: "=" },
            {
              property: "Tot_Srvcs",
              value: String(MIN_SERVICES),
              operator: ">=",
            },
          ],
          sort: [{ property: "Tot_Srvcs", order: "desc" }],
          limit,
          offset: 0,
        }),
      });

      if (!res.ok) {
        logger.warn({ status: res.status, hcpcs }, "CMS Medicare Util API error");
        result.errors += 1;
        continue;
      }

      const body = (await res.json()) as CmsResponse;
      const records = body.data ?? [];

      for (const rec of records) {
        const npi = rec.Rndrng_NPI?.trim();
        if (!npi) continue;

        const totSrvcs = Number(rec.Tot_Srvcs ?? 0);
        if (totSrvcs < MIN_SERVICES) continue;

        try {
          const facilityId = await matchFacilityByNpi(npi);
          if (!facilityId) {
            await sleep(DELAY_MS);
            continue;
          }

          const signalValue = `medicare_util:${npi}:${hcpcs}`;
          const [exists] = await db
            .select({ id: purchaseSignals.id })
            .from(purchaseSignals)
            .where(
              and(
                eq(purchaseSignals.facilityId, facilityId),
                eq(purchaseSignals.signalType, "high_utilization"),
                eq(purchaseSignals.signalValue, signalValue),
              ),
            )
            .limit(1);

          if (!exists) {
            const confidence = Math.round(
              Math.min(100, (totSrvcs / 5_000) * 100),
            );
            await db.insert(purchaseSignals).values({
              facilityId,
              signalType: "high_utilization",
              signalValue,
              confidence,
              source: "medicare_util",
              isActive: true,
            });
            result.signalsInserted += 1;
          }
        } catch (err) {
          logger.warn({ err, npi, hcpcs }, "Medicare util record error");
          result.errors += 1;
        }

        await sleep(DELAY_MS);
      }
    } catch (err) {
      logger.error({ err, hcpcs }, "Medicare util HCPCS fetch error");
      result.errors += 1;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "medicare_util ingest complete");
  return result;
}
