/**
 * SEC EDGAR ingestor — free public source, no API key required.
 *
 * Performs up to three EDGAR searches per facility:
 *   1. The facility's own name (confidence 72 on a direct hit).
 *   2. The facility's systemName field when set.
 *   3. The parent health system facility's name via parentSystemId lookup.
 *
 * Hits from searches (2) or (3) are stored with source = 'sec_edgar' at
 * confidence 85, and tagged via metadata.matchedVia = 'parent_system' to
 * distinguish them from direct-name hits. Accession numbers are de-duplicated
 * across all searches so each filing is written at most once per facility.
 * Form types: 424B3, 424B5, S-1, S-11, 424B4, FWP.
 *
 * Docs: https://efts.sec.gov/LATEST/search-index (EDGAR EFTS)
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_FORMS = "10-K,8-K,S-1,FWP,424B3,424B4,424B5";
const DELAY_MS = 500;

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
  const url = `${EDGAR_SEARCH}?${params}`;
  const headers = { Accept: "application/json", "User-Agent": "MedIntelOS research@medintel.ai" };

  // Retry up to 3 times on 500 with exponential backoff (500ms, 1s, 2s).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * Math.pow(2, attempt - 1));
    const res = await fetch(url, { headers });
    if (res.status === 500) continue;          // transient — retry
    if (!res.ok) return { accessions: [], httpError: res.status !== 404 };
    const json = (await res.json()) as EdgarResponse;
    const hits = json.hits?.hits ?? [];
    const accessions = hits
      .slice(0, maxHits)
      .map((h) => h._source?.accession_no ?? "")
      .filter(Boolean);
    return { accessions, httpError: false };
  }
  // All retries exhausted — treat as a transient skip, not a hard error.
  return { accessions: [], httpError: false };
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestSecEdgar(
  opts: { limit?: number; states?: string[] } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 500));
  const stateFilter = opts.states?.length ? inArray(facilities.state, opts.states) : undefined;
  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  const targets = await db
    .select()
    .from(facilities)
    .where(stateFilter)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  // Cache parent system names to avoid re-fetching for sibling facilities.
  const parentNameCache = new Map<string, string>();

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      // Search by facility's own name. Trim to the first comma/dash segment,
      // strip apostrophes, then cap at 50 chars — but on a WORD boundary so
      // multi-token names like "Medical University of South Carolina
      // Healthcare System" don't get cut mid-token ("...Healthcare " is far
      // worse than "Medical University of South Carolina Healthcare").
      const facilityTermRaw = f.name.split(/[,\-]/)[0].trim().replace(/'/g, "");
      const facilityTerm =
        facilityTermRaw.length <= 50
          ? facilityTermRaw
          : facilityTermRaw.slice(0, 50).replace(/\s+\S*$/, "").trim() || facilityTermRaw.slice(0, 50);
      const { accessions: directList, httpError: directErr } = await searchEdgar(facilityTerm, 5);
      if (directErr) result.errors += 1;
      const directAccessions = new Set(directList);

      // Collect system/parent search terms to deduplicate before querying.
      // We search by: (a) facility.systemName when set, and (b) the parent
      // system facility's name when parentSystemId is populated.
      const systemTerms = new Set<string>();

      if (f.systemName) {
        const st = f.systemName.split(/[,\-]/)[0].trim().replace(/'/g, "").slice(0, 50);
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
          const pt = parentName.split(/[,\-]/)[0].trim().replace(/'/g, "").slice(0, 50);
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
