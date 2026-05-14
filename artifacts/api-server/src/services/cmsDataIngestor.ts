/**
 * CMS Provider Data ingestor — free public source, no API key required.
 *
 * Queries the CMS Hospital General Information dataset (data.cms.gov) for
 * each tracked facility by name + state. The certification date from CMS
 * indicates when the facility last underwent a payment certification review —
 * a natural capital-planning milestone. We emit a `fiscal_year_end` signal
 * keyed by provider ID + certification year so it's idempotent across runs.
 *
 * Dataset: https://data.cms.gov/provider-data/dataset/xubh-q36u
 * API: https://data.cms.gov/resource/xubh-q36u.json (Socrata SODA)
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const CMS_API = "https://data.cms.gov/resource/xubh-q36u.json";
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CmsHospital {
  provider_id?: string;
  facility_name?: string;
  state?: string;
  city_town?: string;
  certification_date?: string;
  overall_rating?: string;
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestCmsData(
  opts: { limit?: number } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
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
    try {
      // Use first word of facility name + state to narrow the search safely.
      const shortName = f.name.split(/[\s,\-]/)[0].trim().slice(0, 20);
      // Socrata LIKE requires % encoded as %25 inside a $where clause.
      const where = `upper(facility_name) LIKE upper('%25${shortName}%25') AND state='${f.state}'`;
      const params = new URLSearchParams({
        $where: where,
        $limit: "3",
      });
      const res = await fetch(`${CMS_API}?${params}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "MedIntel/1.0",
        },
      });
      if (!res.ok) {
        if (res.status !== 404) result.errors += 1;
        continue;
      }
      const rows = (await res.json()) as CmsHospital[];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const row = rows[0];
      const providerId = row.provider_id;
      const certDate = row.certification_date;
      if (!providerId || !certDate) continue;

      const certYear = new Date(certDate).getFullYear();
      if (isNaN(certYear)) continue;

      const signalValue = `cms:${providerId}:${certYear}`;
      const [exists] = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(
          and(
            eq(purchaseSignals.facilityId, f.id),
            eq(purchaseSignals.signalType, "fiscal_year_end"),
            eq(purchaseSignals.signalValue, signalValue),
          ),
        )
        .limit(1);
      if (!exists) {
        await db.insert(purchaseSignals).values({
          facilityId: f.id,
          signalType: "fiscal_year_end",
          signalValue,
          confidence: 68,
          source: "cms_provider_data",
          isActive: true,
        });
        result.signalsInserted += 1;
      }

      await db
        .update(facilities)
        .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
        .where(eq(facilities.id, f.id));
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "cms_data fetch error");
      result.errors += 1;
      continue;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "cms_data ingest complete");
  return result;
}
