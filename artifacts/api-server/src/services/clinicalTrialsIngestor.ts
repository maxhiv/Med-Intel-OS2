/**
 * ClinicalTrials.gov v2 ingestor — free public source, no API key required.
 *
 * For each tracked facility we ask the public API for recently-updated trials
 * naming that facility as a study location. Each new trial becomes an active
 * `clinical_trial` purchase signal. The signal is keyed by NCT id so reruns
 * are idempotent.
 *
 * Docs: https://clinicaltrials.gov/data-api/api
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  type Facility,
} from "@workspace/db";
import { logger } from "../lib/logger";

const CT_API = "https://clinicaltrials.gov/api/v2/studies";

interface CtStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: {
      overallStatus?: string;
      lastUpdatePostDateStruct?: { date?: string };
    };
    contactsLocationsModule?: {
      locations?: { facility?: string; city?: string; state?: string }[];
    };
  };
}

interface CtResponse {
  studies?: CtStudy[];
}

const ACTIVE_STATUSES = new Set([
  "RECRUITING",
  "NOT_YET_RECRUITING",
  "ACTIVE_NOT_RECRUITING",
  "ENROLLING_BY_INVITATION",
]);

function buildQuery(facility: Facility): string {
  const params = new URLSearchParams({
    "query.locn": facility.name,
    "filter.overallStatus":
      "RECRUITING|NOT_YET_RECRUITING|ACTIVE_NOT_RECRUITING|ENROLLING_BY_INVITATION",
    pageSize: "20",
    format: "json",
    countTotal: "false",
    fields:
      "protocolSection.identificationModule,protocolSection.statusModule,protocolSection.contactsLocationsModule",
  });
  if (facility.state) params.set("query.locn", `${facility.name} ${facility.state}`);
  return `${CT_API}?${params.toString()}`;
}

async function fetchTrialsForResult(
  facility: Facility,
): Promise<{ ok: boolean; studies: CtStudy[] }> {
  const url = buildQuery(facility);
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
  });
  if (!res.ok) {
    logger.warn(
      { status: res.status, facilityId: facility.id },
      "clinicaltrials.gov fetch failed",
    );
    return { ok: false, studies: [] };
  }
  const json = (await res.json()) as CtResponse;
  return { ok: true, studies: json.studies ?? [] };
}

function studyMatchesFacility(study: CtStudy, facility: Facility): boolean {
  const locs = study.protocolSection?.contactsLocationsModule?.locations ?? [];
  if (locs.length === 0) return false;
  const target = facility.name.toLowerCase();
  return locs.some((l) => {
    const f = (l.facility ?? "").toLowerCase();
    if (!f) return false;
    if (facility.state && l.state && l.state !== facility.state) return false;
    return f.includes(target) || target.includes(f);
  });
}

export interface IngestResult {
  facilitiesScanned: number;
  trialsFetched: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestClinicalTrials(opts: {
  limit?: number;
  states?: string[];
} = {}): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const stateFilter = opts.states?.length ? inArray(facilities.state, opts.states) : undefined;

  // Prioritise facilities we haven't scraped recently. Order by oldest
  // last_scraped_at first so each tick walks the back of the queue.
  const targets = await db
    .select()
    .from(facilities)
    .where(stateFilter)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  const result: IngestResult = {
    facilitiesScanned: 0,
    trialsFetched: 0,
    signalsInserted: 0,
    errors: 0,
  };

  for (const f of targets) {
    result.facilitiesScanned += 1;
    let studies: CtStudy[] = [];
    let fetchOk = true;
    try {
      const r = await fetchTrialsForResult(f);
      fetchOk = r.ok;
      studies = r.studies;
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "clinicaltrials fetch threw");
      result.errors += 1;
      // Don't advance lastScrapedAt on a thrown error — let retry happen next tick.
      continue;
    }
    if (!fetchOk) {
      result.errors += 1;
      // Same: leave lastScrapedAt alone so a transient upstream failure
      // doesn't push this facility to the back of the queue.
      continue;
    }
    result.trialsFetched += studies.length;

    for (const s of studies) {
      const nct = s.protocolSection?.identificationModule?.nctId;
      const status = s.protocolSection?.statusModule?.overallStatus;
      if (!nct || !status || !ACTIVE_STATUSES.has(status)) continue;
      if (!studyMatchesFacility(s, f)) continue;

      // Idempotency: skip if we already have this NCT for this facility.
      const [exists] = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(
          and(
            eq(purchaseSignals.facilityId, f.id),
            eq(purchaseSignals.signalType, "clinical_trial"),
            eq(purchaseSignals.signalValue, nct),
          ),
        )
        .limit(1);
      if (exists) continue;

      await db.insert(purchaseSignals).values({
        facilityId: f.id,
        signalType: "clinical_trial",
        signalValue: nct,
        confidence: 70,
        source: "clinicaltrials",
        isActive: true,
      });
      result.signalsInserted += 1;
    }

    await db
      .update(facilities)
      .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
      .where(eq(facilities.id, f.id));
  }

  logger.info(result, "clinicaltrials ingest complete");
  return result;
}
