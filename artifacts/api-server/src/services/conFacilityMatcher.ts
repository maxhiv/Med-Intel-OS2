/**
 * CON applicant → facility matcher.
 *
 * The CON ingestor receives free-text `applicant_name` strings off state
 * portals and must map each one to a tracked `facilities` row so the filing
 * can roll into the facility's signal score and the UI can deep-link to the
 * facility detail page. This module owns that resolution step.
 *
 * Two entry points:
 *   - `resolveConApplicantToFacility` — called inline by the ingestor for
 *     each newly-fetched filing (NPI exact match → token-narrowed fuzzy
 *     scoring via `facilityNameMatch`).
 *   - `backfillConFilingFacilities` — one-shot pass over existing
 *     `con_filings` rows whose `facility_id` is still NULL, useful when
 *     the matcher improves or new facilities are added after ingestion.
 *
 * The fuzzy scoring lives in `facilityNameMatch` and is unit tested
 * separately; this module is intentionally just the DB-bound glue.
 */
import { and, eq, gt, ilike, isNull, or, asc } from "drizzle-orm";
import { db, facilities, conFilings, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  candidateTokens,
  pickBestFacility,
  DEFAULT_MATCH_THRESHOLD,
  type FacilityCandidate,
} from "./facilityNameMatch";

/** Maximum candidate facilities pulled from the DB before fuzzy scoring. */
const CANDIDATE_POOL_LIMIT = 50;

export interface ConFacilityResolution {
  id: string;
  score: number;
  matchedField: "name" | "dba" | "system" | "npi";
  /**
   * True when the match is geographically verified — either an exact NPI hit
   * or a fuzzy hit drawn from a county-gated candidate pool. A county-confirmed
   * match can be auto-approved at the lower fuzzy threshold; an unconfirmed one
   * still needs the higher review threshold.
   */
  countyConfirmed: boolean;
}

/**
 * Try to resolve a tracked facility for a CON filing.
 *
 * Resolution order:
 *   1. Exact NPI match (strongest signal, no state filter needed).
 *   2. Token-based candidate pool from `name`, `doing_business_as` and
 *      `system_name` within the same state, then fuzzy-scored with
 *      `pickBestFacility`. The applicant string is split on `d/b/a`,
 *      `on behalf of`, etc. so parent-system filings still resolve.
 *
 * When a `county` is supplied (scraped from the filing document) the candidate
 * pool is *hard-gated* to facilities in that county. This is the single most
 * important guard against cross-county false positives — e.g. a Wilkes County
 * filing fuzzy-matching "Wilson Medical Center". If no facility in the county
 * resolves, the function returns `null` (filing stays unmatched) rather than
 * guessing a facility in the wrong county.
 *
 * Returns `null` (not throws) if no candidate clears the confidence threshold.
 */
export async function resolveConApplicantToFacility(
  applicant: string,
  state: string,
  npi?: string,
  opts: { county?: string | null } = {},
): Promise<ConFacilityResolution | null> {
  // 1. Exact NPI match — strongest signal, no state filter needed.
  if (npi && /^\d{10}$/.test(npi)) {
    const [byNpi] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.npi, npi))
      .limit(1);
    if (byNpi) return { id: byNpi.id, score: 1, matchedField: "npi", countyConfirmed: true };
  }

  // 2. Build a small candidate pool keyed on shared meaningful tokens across
  // any of name / DBA / system_name. We use the longest tokens first so noisy
  // 4-letter tokens don't blow the pool past the limit.
  const tokens = candidateTokens(applicant).slice(0, 6);
  if (tokens.length === 0) return null;

  const tokenConds = tokens.flatMap((t) => {
    const pattern = `%${t}%`;
    return [
      ilike(facilities.name, pattern),
      ilike(facilities.doingBusinessAs, pattern),
      ilike(facilities.systemName, pattern),
    ];
  });

  const county = opts.county?.trim().replace(/\s+county$/i, "") || null;
  const where = [eq(facilities.state, state), or(...tokenConds)];
  if (county) {
    // Hard county gate — the right facility is in the filing's county or the
    // filing simply stays unmatched. No cross-county fallback.
    const c = or(
      ilike(facilities.county, county),
      ilike(facilities.county, `${county} County`),
    );
    if (c) where.push(c);
  }

  const rows = await db
    .select({
      id: facilities.id,
      name: facilities.name,
      doingBusinessAs: facilities.doingBusinessAs,
      systemName: facilities.systemName,
    })
    .from(facilities)
    .where(and(...where))
    .limit(CANDIDATE_POOL_LIMIT);

  if (rows.length === 0) return null;

  const candidates: FacilityCandidate[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    doingBusinessAs: r.doingBusinessAs,
    systemName: r.systemName,
  }));
  const best = pickBestFacility(applicant, candidates, {
    threshold: DEFAULT_MATCH_THRESHOLD,
  });
  if (!best) return null;
  logger.debug(
    {
      applicant,
      state,
      county,
      facilityId: best.facility.id,
      score: Number(best.score.toFixed(3)),
      via: best.matchedField,
      pool: rows.length,
    },
    "con applicant matched to facility",
  );
  return {
    id: best.facility.id,
    score: best.score,
    matchedField: best.matchedField,
    countyConfirmed: Boolean(county),
  };
}

export interface BackfillResult {
  scanned: number;
  matched: number;
  errors: number;
  signalsInserted: number;
}

/**
 * One-shot backfill: scan `con_filings` rows whose `facility_id` is NULL,
 * try to match each one with the current matcher, and write the link back
 * when found. Optionally emits the matching `purchase_signals` row that the
 * ingestor would have written had the match landed at insert time.
 *
 * Bounded by `limit` (default 1000) so a misbehaving run can't lock up the
 * DB. Caller can re-invoke until `matched === 0` to drain the backlog.
 */
export async function backfillConFilingFacilities(
  opts: {
    limit?: number;
    /** When true (default) also write a purchase_signals row per match. */
    emitSignals?: boolean;
    /**
     * Page size for the cursor walk. The matcher pages through ALL unmatched
     * rows up to `limit` even when most don't resolve, so a stale prefix of
     * permanently-unmatched rows can never starve newer candidates.
     */
    pageSize?: number;
  } = {},
): Promise<BackfillResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 200, limit));
  const emitSignals = opts.emitSignals ?? true;

  const result: BackfillResult = {
    scanned: 0,
    matched: 0,
    errors: 0,
    signalsInserted: 0,
  };

  // Cursor walk by id (after createdAt order). Within a single createdAt
  // tick we tie-break on id so the cursor is strictly monotonic and we can't
  // re-process the same row twice. Importantly, the cursor advances even
  // for rows the matcher couldn't resolve — without this, a large early
  // slice of permanently-unmatched filings would starve newer candidates.
  let cursorId: string | null = null;

  while (result.scanned < limit) {
    const remaining = limit - result.scanned;
    const take = Math.min(pageSize, remaining);

    const baseConds = [isNull(conFilings.facilityId)];
    if (cursorId) baseConds.push(gt(conFilings.id, cursorId));
    const rows = await db
      .select({
        id: conFilings.id,
        state: conFilings.state,
        applicantName: conFilings.applicantName,
        filingUrl: conFilings.filingUrl,
        status: conFilings.status,
        county: conFilings.county,
      })
      .from(conFilings)
      .where(and(...baseConds))
      .orderBy(asc(conFilings.id))
      .limit(take);

    if (rows.length === 0) break;
    result.scanned += rows.length;
    cursorId = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.applicantName || !row.state) continue;
      try {
        const facility = await resolveConApplicantToFacility(
          row.applicantName,
          row.state,
          undefined,
          { county: row.county },
        );
        if (!facility) continue;

        // Conditional update with `RETURNING` so we only count this row as
        // matched if our update actually claimed it (i.e. another concurrent
        // backfill or admin link-action didn't beat us to it).
        const claimed = await db
          .update(conFilings)
          .set({ facilityId: facility.id })
          .where(and(eq(conFilings.id, row.id), isNull(conFilings.facilityId)))
          .returning({ id: conFilings.id });
        if (claimed.length === 0) continue;
        result.matched += 1;

        if (!emitSignals || !row.filingUrl) continue;

        // Mirror the ingestor's signal-emission rules: approved-status
        // filings get a higher-confidence `con_approved` signal, everything
        // else becomes `con_filed`. Skip if a matching signal already exists
        // so re-running the backfill stays idempotent.
        const approved = /approv|grant(ed)?|issued/i.test(row.status ?? "");
        const signalType = approved ? "con_approved" : "con_filed";
        const [sigExists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, facility.id),
              eq(purchaseSignals.signalType, signalType),
              eq(purchaseSignals.signalValue, row.filingUrl),
            ),
          )
          .limit(1);
        if (sigExists) continue;

        await db.insert(purchaseSignals).values({
          facilityId: facility.id,
          signalType,
          signalValue: row.filingUrl,
          confidence: approved ? 90 : 75,
          source: "con_filing",
          sourceId: row.id,
          isActive: true,
        });
        result.signalsInserted += 1;

        // Touch facility freshness so downstream scoring picks up the link.
        await db
          .update(facilities)
          .set({ updatedAt: new Date() })
          .where(eq(facilities.id, facility.id));
      } catch (err) {
        result.errors += 1;
        logger.warn(
          { err, conFilingId: row.id },
          "con backfill match failed for row",
        );
      }
    }

    if (rows.length < take) break;
  }

  logger.info(result, "con facility backfill complete");
  return result;
}
