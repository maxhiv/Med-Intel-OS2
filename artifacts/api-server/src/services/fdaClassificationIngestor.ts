/**
 * FDA Device Classification ingestor — free public source, no API key required.
 *
 * Fetches Class II and Class III radiology/imaging device classifications from
 * openFDA. When a facility has equipment records (or a facility type that
 * implies imaging use), any matching high-risk classification is an EOL signal:
 * Class II/III regulations accelerate replacement cycles and drive capital
 * purchase decisions.
 *
 * Docs: https://open.fda.gov/apis/device/classification/
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  equipmentRecords,
} from "@workspace/db";
import { logger } from "../lib/logger";

const FDA_CLASS_API =
  "https://api.fda.gov/device/classification.json?search=medical_specialty_description:%22Radiology%22+AND+device_class:%5B2+TO+3%5D&limit=100";

const IMAGING_FACILITY_TYPES = [
  "hospital",
  "imaging",
  "radiology",
  "diagnostic",
  "cancer",
  "oncology",
];

interface FdaClassResult {
  error?: unknown;
  results?: {
    product_code?: string;
    device_name?: string;
    device_class?: string;
    medical_specialty_description?: string;
  }[];
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

function facilityUsesImaging(facilityType: string): boolean {
  const lower = facilityType.toLowerCase();
  return IMAGING_FACILITY_TYPES.some((t) => lower.includes(t));
}

export async function ingestFdaClassification(
  opts: { limit?: number } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  // Fetch the FDA classification list once — shared across all facilities.
  let productCodes: string[] = [];
  try {
    const res = await fetch(FDA_CLASS_API, {
      headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
    });
    if (res.ok) {
      const json = (await res.json()) as FdaClassResult;
      productCodes =
        json.results
          ?.map((r) => r.product_code)
          .filter((c): c is string => Boolean(c))
          .slice(0, 10) ?? [];
    } else if (res.status !== 404) {
      result.errors += 1;
    }
  } catch (err) {
    logger.warn({ err }, "fda_classification list fetch error");
    result.errors += 1;
  }

  if (productCodes.length === 0) {
    logger.info(result, "fda_classification ingest complete (no product codes)");
    return result;
  }

  const targets = await db
    .select()
    .from(facilities)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      // Determine if facility is an imaging user via equipment records or type.
      const hasEquipment =
        (
          await db
            .select({ id: equipmentRecords.id })
            .from(equipmentRecords)
            .where(eq(equipmentRecords.facilityId, f.id))
            .limit(1)
        ).length > 0;

      const isImagingFacility = hasEquipment || facilityUsesImaging(f.facilityType);
      if (!isImagingFacility) continue;

      // Emit one signal per product code (up to 3 to keep noise low).
      for (const code of productCodes.slice(0, 3)) {
        const signalValue = `fdaclass:${code}`;
        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, f.id),
              eq(purchaseSignals.signalType, "eol_equipment"),
              eq(purchaseSignals.signalValue, signalValue),
            ),
          )
          .limit(1);
        if (exists) continue;

        await db.insert(purchaseSignals).values({
          facilityId: f.id,
          signalType: "eol_equipment",
          signalValue,
          confidence: 60,
          source: "fda_classification",
          isActive: true,
        });
        result.signalsInserted += 1;
      }

      await db
        .update(facilities)
        .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
        .where(eq(facilities.id, f.id));
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "fda_classification facility error");
      result.errors += 1;
    }
  }

  logger.info(result, "fda_classification ingest complete");
  return result;
}
