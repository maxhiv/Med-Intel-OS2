/**
 * CMS Provider Data ingestor — free public source, no API key required.
 *
 * Queries the CMS Hospital General Information dataset (data.cms.gov) for
 * each tracked facility by name + state. We emit a `fiscal_year_end` signal
 * keyed by provider ID + current year (CMS refreshes this dataset annually).
 *
 * Dataset: https://data.cms.gov/provider-data/dataset/xubh-q36u
 * API: https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0
 *
 * NOTE: The old Socrata endpoint (data.cms.gov/resource/xubh-q36u.json) was
 * permanently retired (HTTP 410) in 2024. This ingestor uses the replacement
 * CMS Provider Data Catalog API which is free and requires no API key.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const CMS_API =
  "https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0";
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CmsHospital {
  facility_id?: string;
  facility_name?: string;
  state?: string;
  citytown?: string;
  hospital_overall_rating?: string;
}

interface CmsResponse {
  results?: CmsHospital[];
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

  const currentYear = new Date().getFullYear();

  const targets = await db
    .select()
    .from(facilities)
    .where(sql`${facilities.state} IS NOT NULL`)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      const shortName = f.name.split(/[\s,\-]/)[0].trim().slice(0, 20);

      // CMS Provider Data Catalog API uses conditions[] filter syntax
      const params = new URLSearchParams({
        "conditions[0][property]": "facility_name",
        "conditions[0][value]": `%${shortName}%`,
        "conditions[0][operator]": "LIKE",
        "conditions[1][property]": "state",
        "conditions[1][value]": f.state ?? "",
        "conditions[1][operator]": "=",
        limit: "3",
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

      const body = (await res.json()) as CmsResponse;
      const rows = body.results ?? [];
      if (rows.length === 0) continue;

      const row = rows[0];
      const providerId = row.facility_id;
      const rating = row.hospital_overall_rating;
      if (!providerId || !rating || rating === "Not Available") continue;

      const signalValue = `cms:${providerId}:${currentYear}`;
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
