/**
 * SEC EDGAR ingestor — free public source, no API key required.
 *
 * Performs two EDGAR searches per facility:
 *   1. The facility's own name (confidence 72 on a direct hit).
 *   2. The parent health system's name when parentSystemId is populated
 *      (confidence 85; source = 'sec_edgar_parent', encoding matchedVia =
 *      'parent_system').
 *
 * Accession numbers are de-duplicated across both searches so each filing is
 * written at most once per facility. Form types: 424B3, 424B5, S-1, S-11,
 * 424B4, FWP.
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

async function searchEdgar(
  term: string,
  maxHits = 5,
): Promise<{ accessions: string[]; httpError: boolean }> {
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
  if (!res.ok) {
    return { accessions: [], httpError: res.status !== 404 };
  }
  const json = (await res.json()) as EdgarResponse;
  const hits = json.hits?.hits ?? [];
  const accessions = hits
    .slice(0, maxHits)
    .map((h) => h._source?.accession_no ?? "")
    .filter(Boolean);
  return { accessions, httpError: false };
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

  // Cache parent system names to avoid re-fetching for sibling facilities.
  const parentNameCache = new Map<string, string>();

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      // Search by facility's own name.
      const facilityTerm = f.name.split(/[,\-]/)[0].trim();
      const { accessions: directList, httpError: directErr } = await searchEdgar(facilityTerm, 5);
      if (directErr) result.errors += 1;
      const directAccessions = new Set(directList);

      // Collect system/parent search terms to deduplicate before querying.
      // We search by: (a) facility.systemName when set, and (b) the parent
      // system facility's name when parentSystemId is populated.
      const systemTerms = new Set<string>();

      if (f.systemName) {
        const st = f.systemName.split(/[,\-]/)[0].trim();
        if (st.toLowerCase() !== facilityTerm.toLowerCase()) systemTerms.add(st);
      }

      if (f.parentSystemId) {
        let parentName = parentNameCache.get(f.parentSystemId);
        if (!parentName) {
          const [parent] = await db
            .select({ name: facilities.name })
            .from(facilities)
            .where(eq(facilities.id, f.parentSystemId))
            .limit(1);
          parentName = parent?.name;
          if (parentName) parentNameCache.set(f.parentSystemId, parentName);
        }
        if (parentName) {
          const pt = parentName.split(/[,\-]/)[0].trim();
          if (pt.toLowerCase() !== facilityTerm.toLowerCase()) systemTerms.add(pt);
        }
      }

      let parentOnlyAccessions: string[] = [];
      for (const term of systemTerms) {
        await sleep(DELAY_MS);
        const { accessions: pList, httpError: pErr } = await searchEdgar(term, 5);
        if (pErr) result.errors += 1;
        for (const a of pList) {
          if (!directAccessions.has(a) && !parentOnlyAccessions.includes(a)) {
            parentOnlyAccessions.push(a);
          }
        }
      }

      // Upsert: direct accessions at confidence 72; parent-system accessions at
      // confidence 85 with metadata.matchedVia = 'parent_system'.
      const toInsert: Array<{
        accession: string;
        confidence: number;
        source: string;
        metadata: Record<string, string> | null;
      }> = [
        ...[...directAccessions].slice(0, 3).map((a) => ({
          accession: a,
          confidence: 72,
          source: "sec_edgar",
          metadata: null,
        })),
        ...parentOnlyAccessions.slice(0, 3).map((a) => ({
          accession: a,
          confidence: 85,
          source: "sec_edgar",
          metadata: { matchedVia: "parent_system" },
        })),
      ];

      for (const { accession, confidence, source, metadata } of toInsert) {
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
          metadata,
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
