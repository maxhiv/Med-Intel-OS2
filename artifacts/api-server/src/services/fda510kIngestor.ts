/**
 * FDA 510(k) device clearances ingestor — free public source, no API key required.
 *
 * For each tracked facility we search the openFDA device/510k endpoint for
 * clearances associated with the facility's short name. Each new 510(k) K-number
 * becomes a `service_line_expansion` purchase signal, keyed by the K-number so
 * reruns are idempotent. HTTP 404 from openFDA means no results — not an error.
 *
 * Docs: https://open.fda.gov/apis/device/510k/
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  type Facility,
} from "@workspace/db";
import { logger } from "../lib/logger";

const FDA_510K_API = "https://api.fda.gov/device/510k.json";

interface Fda510kDevice {
  k_number?: string;
  applicant?: string;
  device_name?: string;
  decision_date?: string;
  decision_description?: string;
}

interface Fda510kResponse {
  meta?: { results?: { total?: number } };
  results?: Fda510kDevice[];
}

async function fetchFda510kForFacility(
  facility: Facility,
): Promise<{ ok: boolean; notFound: boolean; devices: Fda510kDevice[] }> {
  const shortName = facility.name.split(/[,\-]/)[0].trim();
  const searchParam = `applicant:"${shortName}"`;
  const params = new URLSearchParams({
    search: searchParam,
    sort: "decision_date:desc",
    limit: "5",
  });
  const url = `${FDA_510K_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
  });
  if (res.status === 404) {
    return { ok: true, notFound: true, devices: [] };
  }
  if (!res.ok) {
    logger.warn(
      { status: res.status, facilityId: facility.id },
      "fda 510k fetch failed",
    );
    return { ok: false, notFound: false, devices: [] };
  }
  const json = (await res.json()) as Fda510kResponse;
  return { ok: true, notFound: false, devices: json.results ?? [] };
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestFda510k(opts: {
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

    let devices: Fda510kDevice[] = [];
    let fetchOk = true;
    try {
      const r = await fetchFda510kForFacility(f);
      fetchOk = r.ok;
      devices = r.devices;
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "fda 510k fetch threw");
      result.errors += 1;
      continue;
    }
    if (!fetchOk) {
      result.errors += 1;
      continue;
    }

    for (const device of devices) {
      const kNumber = device.k_number;
      if (!kNumber) continue;

      const [exists] = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(
          and(
            eq(purchaseSignals.facilityId, f.id),
            eq(purchaseSignals.signalType, "service_line_expansion"),
            eq(purchaseSignals.signalValue, kNumber),
          ),
        )
        .limit(1);
      if (exists) continue;

      await db.insert(purchaseSignals).values({
        facilityId: f.id,
        signalType: "service_line_expansion",
        signalValue: kNumber,
        confidence: 75,
        source: "fda_510k",
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

  logger.info(result, "fda 510k ingest complete");
  return result;
}
