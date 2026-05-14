/**
 * SEC EDGAR ingestor — free public source, no API key required.
 *
 * Searches the EDGAR full-text search index for prospectus and shelf-offering
 * filings (424B3, 424B5, S-1, S-11, 424B4, FWP) by both the facility's own
 * name and its parent health system's name (when parentSystemId is populated).
 * Results are de-duplicated by accession number. Parent-system matches are
 * tagged with source = 'sec_edgar_parent' and confidence = 85.
 *
 * Docs: https://efts.sec.gov/LATEST/search-index (EDGAR EFTS)
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_FORMS = "424B3,424B5,S-1,S-11,424B4,FWP";
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface EdgarHit {
  _source?: {
    accession_no?: string;
    file_date?: string;
    entity_name?: string;
    form_type?: string;
  };
}

interface EdgarResponse {
  hits?: {
    hits?: EdgarHit[];
    total?: { value?: number };
  };
}

function oneYearAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Search EDGAR for a single term; returns up to `maxHits` accession numbers. */
async function searchEdgar(term: string, maxHits = 5): Promise<string[]> {
  const params = new URLSearchParams({
    q: `"${term}"`,
    forms: EDGAR_FORMS,
    dateRange: "custom",
    startdt: oneYearAgo(),
    enddt: today(),
  });
  const res = await fetch(`${EDGAR_SEARCH}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as EdgarResponse;
  const hits = json.hits?.hits ?? [];
  return hits
    .slice(0, maxHits)
    .map((h) => h._source?.accession_no ?? "")
    .filter(Boolean);
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestSecEdgar(
  opts: { limit?: number } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 500));
  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  const targets = await db
    .select()
    .from(facilities)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  // Build a parent-name cache so we don't re-fetch the same parent for siblings.
  const parentNameCache = new Map<string, string>();

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      // ── Search 1: facility's own name (or systemName if set) ──────────────
      const facilityTerm = (f.systemName ?? f.name).split(/[,\-]/)[0].trim();
      const facilityHits = await searchEdgar(facilityTerm, 5);

      // ── Search 2: parent health system name (if parentSystemId set) ───────
      let parentHits: string[] = [];
      let parentSystemName: string | null = null;
      if (f.parentSystemId) {
        if (parentNameCache.has(f.parentSystemId)) {
          parentSystemName = parentNameCache.get(f.parentSystemId) ?? null;
        } else {
          const [parent] = await db
            .select({ name: facilities.name })
            .from(facilities)
            .where(eq(facilities.id, f.parentSystemId))
            .limit(1);
          parentSystemName = parent?.name ?? null;
          if (parentSystemName) parentNameCache.set(f.parentSystemId, parentSystemName);
        }
        if (parentSystemName) {
          const parentTerm = parentSystemName.split(/[,\-]/)[0].trim();
          // Only do a second search if parent name differs meaningfully from facility search term
          if (parentTerm.toLowerCase() !== facilityTerm.toLowerCase()) {
            await sleep(DELAY_MS);
            parentHits = await searchEdgar(parentTerm, 5);
          }
        }
      }

      // ── De-duplicate across both searches ────────────────────────────────
      const facilityAccessions = new Set(facilityHits);
      // parentHits that aren't already in facility hits
      const parentOnlyAccessions = parentHits.filter((a) => !facilityAccessions.has(a));

      // ── Upsert signals ────────────────────────────────────────────────────
      for (const accession of [...facilityHits.slice(0, 3), ...parentOnlyAccessions.slice(0, 3)]) {
        const isParentMatch = !facilityAccessions.has(accession);
        const confidence = isParentMatch ? 85 : (f.systemName && f.systemName !== f.name ? 85 : 72);
        const source = isParentMatch ? "sec_edgar_parent" : "sec_edgar";

        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, f.id),
              eq(purchaseSignals.signalType, "bond_issuance"),
              eq(purchaseSignals.signalValue, accession),
            ),
          )
          .limit(1);
        if (exists) continue;

        await db.insert(purchaseSignals).values({
          facilityId: f.id,
          signalType: "bond_issuance",
          signalValue: accession,
          confidence,
          source,
          isActive: true,
        });
        result.signalsInserted += 1;
      }

      await db
        .update(facilities)
        .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
        .where(eq(facilities.id, f.id));
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "sec_edgar fetch error");
      result.errors += 1;
      continue;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "sec_edgar ingest complete");
  return result;
}
