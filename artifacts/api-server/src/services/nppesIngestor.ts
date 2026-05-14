/**
 * NPPES NPI Registry ingestor — free public source, no API key required.
 *
 * For each tracked facility with a known NPI we query the CMS NPI Registry
 * API and look for taxonomy codes that indicate radiology / imaging service
 * lines. Each new imaging taxonomy becomes a `service_line_expansion` purchase
 * signal keyed by `nppes:{code}` so reruns are idempotent.
 *
 * Docs: https://npiregistry.cms.hhs.gov/api-page
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  type Facility,
} from "@workspace/db";
import { logger } from "../lib/logger";

const NPPES_API = "https://npiregistry.cms.hhs.gov/api/";

/** Taxonomy codes for radiology/imaging specialties. */
const IMAGING_TAXONOMY_PREFIXES = ["2085"];
const IMAGING_TAXONOMY_CODES = new Set([
  "261QR0200X",
  "261QI0500X",
  "261QM1200X",
  "261QN0025X",
]);

interface NppesAddress {
  address_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

interface NppesTaxonomy {
  code?: string;
  desc?: string;
  primary?: boolean;
  state?: string;
  license?: string;
}

interface NppesBasic {
  status?: string;
  name?: string;
  organization_name?: string;
}

interface NppesResult {
  number?: string;
  basic?: NppesBasic;
  addresses?: NppesAddress[];
  taxonomies?: NppesTaxonomy[];
}

interface NppesResponse {
  result_count?: number;
  results?: NppesResult[];
}

function isImagingTaxonomy(code: string): boolean {
  if (IMAGING_TAXONOMY_CODES.has(code)) return true;
  return IMAGING_TAXONOMY_PREFIXES.some((prefix) => code.startsWith(prefix));
}

async function fetchNppesForFacility(
  facility: Facility,
): Promise<{ ok: boolean; results: NppesResult[] }> {
  const params = new URLSearchParams({
    version: "2.1",
    number: facility.npi!,
    pretty: "false",
  });
  const url = `${NPPES_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
  });
  if (!res.ok) {
    logger.warn(
      { status: res.status, facilityId: facility.id },
      "nppes fetch failed",
    );
    return { ok: false, results: [] };
  }
  const json = (await res.json()) as NppesResponse;
  return { ok: true, results: json.results ?? [] };
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestNppes(opts: {
  limit?: number;
} = {}): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));

  const targets = await db
    .select()
    .from(facilities)
    .where(isNotNull(facilities.npi))
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  for (const f of targets) {
    result.facilitiesScanned += 1;

    let nppesResults: NppesResult[] = [];
    let fetchOk = true;
    try {
      const r = await fetchNppesForFacility(f);
      fetchOk = r.ok;
      nppesResults = r.results;
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "nppes fetch threw");
      result.errors += 1;
      continue;
    }
    if (!fetchOk) {
      result.errors += 1;
      continue;
    }

    for (const record of nppesResults) {
      if (record.basic?.status !== "A") continue;

      const taxonomies = record.taxonomies ?? [];
      for (const taxonomy of taxonomies) {
        const code = taxonomy.code;
        if (!code || !isImagingTaxonomy(code)) continue;

        const signalValue = `nppes:${code}`;

        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, f.id),
              eq(purchaseSignals.signalType, "service_line_expansion"),
              eq(purchaseSignals.signalValue, signalValue),
            ),
          )
          .limit(1);
        if (exists) continue;

        await db.insert(purchaseSignals).values({
          facilityId: f.id,
          signalType: "service_line_expansion",
          signalValue,
          confidence: 65,
          source: "npi_registry",
          isActive: true,
        });
        result.signalsInserted += 1;
      }
    }

    await db
      .update(facilities)
      .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
      .where(eq(facilities.id, f.id));

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  logger.info(result, "nppes ingest complete");
  return result;
}
