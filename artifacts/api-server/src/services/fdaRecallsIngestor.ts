/**
 * FDA device recalls ingestor — free public source, no API key required.
 *
 * For each tracked facility we search the openFDA device/recall endpoint for
 * recalls associated with the facility's system/short name. Class III recalls
 * are skipped; Class I and II become `eol_equipment` purchase signals keyed by
 * recall_number so reruns are idempotent. HTTP 404 = no results, not an error.
 *
 * Docs: https://open.fda.gov/apis/device/recall/
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  type Facility,
} from "@workspace/db";
import { logger } from "../lib/logger";

const FDA_RECALLS_API = "https://api.fda.gov/device/recall.json";

interface FdaRecall {
  recall_number?: string;
  recalling_firm?: string;
  recall_initiation_date?: string;
  classification?: string;
  product_description?: string;
  reason_for_recall?: string;
}

interface FdaRecallsResponse {
  meta?: { results?: { total?: number } };
  results?: FdaRecall[];
}

async function fetchFdaRecallsForFacility(
  facility: Facility,
): Promise<{ ok: boolean; notFound: boolean; recalls: FdaRecall[] }> {
  const searchName = (facility.systemName ?? facility.name)
    .split(/[,\-]/)[0]
    .trim();
  const searchParam = `recalling_firm:"${searchName}"`;
  const params = new URLSearchParams({
    search: searchParam,
    sort: "recall_initiation_date:desc",
    limit: "5",
  });
  const url = `${FDA_RECALLS_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
  });
  if (res.status === 404) {
    return { ok: true, notFound: true, recalls: [] };
  }
  if (!res.ok) {
    logger.warn(
      { status: res.status, facilityId: facility.id },
      "fda recalls fetch failed",
    );
    return { ok: false, notFound: false, recalls: [] };
  }
  const json = (await res.json()) as FdaRecallsResponse;
  return { ok: true, notFound: false, recalls: json.results ?? [] };
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestFdaRecalls(opts: {
  limit?: number;
} = {}): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));

  const targets = await db
    .select()
    .from(facilities)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  for (const f of targets) {
    result.facilitiesScanned += 1;

    let recalls: FdaRecall[] = [];
    let fetchOk = true;
    try {
      const r = await fetchFdaRecallsForFacility(f);
      fetchOk = r.ok;
      recalls = r.recalls;
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "fda recalls fetch threw");
      result.errors += 1;
      continue;
    }
    if (!fetchOk) {
      result.errors += 1;
      continue;
    }

    for (const recall of recalls) {
      if (recall.classification === "Class III") continue;

      const recallNumber = recall.recall_number;
      if (!recallNumber) continue;

      const [exists] = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(
          and(
            eq(purchaseSignals.facilityId, f.id),
            eq(purchaseSignals.signalType, "eol_equipment"),
            eq(purchaseSignals.signalValue, recallNumber),
          ),
        )
        .limit(1);
      if (exists) continue;

      await db.insert(purchaseSignals).values({
        facilityId: f.id,
        signalType: "eol_equipment",
        signalValue: recallNumber,
        confidence: 82,
        source: "fda_recalls",
        isActive: true,
      });
      result.signalsInserted += 1;
    }

    await db
      .update(facilities)
      .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
      .where(eq(facilities.id, f.id));

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  logger.info(result, "fda recalls ingest complete");
  return result;
}
