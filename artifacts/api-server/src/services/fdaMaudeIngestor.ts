/**
 * FDA MAUDE (Medical Device Adverse Event) ingestor — free public source, no API key required.
 *
 * For each tracked facility (with city + state) we query the openFDA device/event
 * endpoint for adverse events reported near that location. Events are filtered to
 * imaging-related devices only. Each new qualifying event becomes a
 * `compliance_citation` purchase signal keyed by `maude:{mdr_report_key}` so
 * reruns are idempotent. HTTP 404 = no results, not an error.
 *
 * Docs: https://open.fda.gov/apis/device/event/
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  type Facility,
} from "@workspace/db";
import { logger } from "../lib/logger";

const FDA_MAUDE_API = "https://api.fda.gov/device/event.json";

const IMAGING_DEVICE_REGEX =
  /(CT|MRI|ultrasound|radiograph|x-ray|nuclear|mammograph)/i;

interface MaudeDevice {
  generic_name?: string;
  brand_name?: string;
}

interface MaudeEvent {
  mdr_report_key?: string;
  date_received?: string;
  adverse_event_flag?: string;
  device?: MaudeDevice[];
}

interface MaudeResponse {
  meta?: { results?: { total?: number } };
  results?: MaudeEvent[];
}

function isImagingEvent(event: MaudeEvent): boolean {
  const devices = event.device ?? [];
  return devices.some(
    (d) =>
      IMAGING_DEVICE_REGEX.test(d.generic_name ?? "") ||
      IMAGING_DEVICE_REGEX.test(d.brand_name ?? ""),
  );
}

async function fetchMaudeForFacility(
  facility: Facility,
): Promise<{ ok: boolean; notFound: boolean; events: MaudeEvent[] }> {
  const searchParam = `reporter_city:"${facility.city}"+AND+reporter_state:"${facility.state}"+AND+adverse_event_flag:Y`;
  const params = new URLSearchParams({
    search: searchParam,
    sort: "date_received:desc",
    limit: "5",
  });
  const url = `${FDA_MAUDE_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
  });
  if (res.status === 404) {
    return { ok: true, notFound: true, events: [] };
  }
  if (!res.ok) {
    logger.warn(
      { status: res.status, facilityId: facility.id },
      "fda maude fetch failed",
    );
    return { ok: false, notFound: false, events: [] };
  }
  const json = (await res.json()) as MaudeResponse;
  return { ok: true, notFound: false, events: json.results ?? [] };
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestFdaMaude(opts: {
  limit?: number;
} = {}): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));

  const targets = await db
    .select()
    .from(facilities)
    .where(and(isNotNull(facilities.city), isNotNull(facilities.state)))
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  for (const f of targets) {
    result.facilitiesScanned += 1;

    let events: MaudeEvent[] = [];
    let fetchOk = true;
    try {
      const r = await fetchMaudeForFacility(f);
      fetchOk = r.ok;
      events = r.events;
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "fda maude fetch threw");
      result.errors += 1;
      continue;
    }
    if (!fetchOk) {
      result.errors += 1;
      continue;
    }

    for (const event of events) {
      if (!isImagingEvent(event)) continue;

      const mdrKey = event.mdr_report_key;
      if (!mdrKey) continue;

      const signalValue = `maude:${mdrKey}`;

      const [exists] = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(
          and(
            eq(purchaseSignals.facilityId, f.id),
            eq(purchaseSignals.signalType, "compliance_citation"),
            eq(purchaseSignals.signalValue, signalValue),
          ),
        )
        .limit(1);
      if (exists) continue;

      await db.insert(purchaseSignals).values({
        facilityId: f.id,
        signalType: "compliance_citation",
        signalValue,
        confidence: 45,
        source: "fda_maude",
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

  logger.info(result, "fda maude ingest complete");
  return result;
}
