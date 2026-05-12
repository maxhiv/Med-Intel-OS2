import { eq, and, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  equipmentRecords,
  facilityContacts,
  outreachDrafts,
  accountFacilities,
  accountContactEngagement,
} from "@workspace/db";

const WEIGHTS: Record<string, number> = {
  depreciation_flag: 30,
  con_approved: 25,
  con_filed: 15,
  grant_awarded: 12,
  bond_issuance: 10,
  construction_permit: 10,
  leadership_change: 8,
  service_line_expansion: 12,
  job_posting: 6,
  news_expansion: 5,
  eol_equipment: 20,
  accreditation_renewal: 7,
  compliance_citation: 5,
  nih_grant: 8,
  clinical_trial: 6,
  fiscal_year_end: 5,
};

// Engagement weighting. Replies are a strong positive purchase signal; bounces
// indicate stale / wrong contact data and should drag the facility down so it
// stops surfacing on the daily pick list. Opens are weakly positive.
//
// IMPORTANT: engagement is tenant-specific outreach data. Engagement scores
// MUST be scoped per (accountId, facilityId) and per (accountId, contactId)
// so one tenant's CRM activity never moves another tenant's pick list.
const ENGAGEMENT_LOOKBACK_DAYS = 90;
const REPLY_FACILITY_WEIGHT = 6;
const OPEN_FACILITY_WEIGHT = 1;
const BOUNCE_FACILITY_WEIGHT = -4;

const REPLY_CONTACT_WEIGHT = 12;
const OPEN_CONTACT_WEIGHT = 2;
const BOUNCE_CONTACT_WEIGHT = -20;

function lookbackDate(): Date {
  return new Date(Date.now() - ENGAGEMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

interface EngagementCounts {
  replies: number;
  opens: number;
  bounces: number;
}

async function facilityEngagementForAccount(
  accountId: string,
  facilityId: string,
): Promise<EngagementCounts> {
  const since = lookbackDate();
  const [row] = await db
    .select({
      replies: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.repliedAt} IS NOT NULL AND ${outreachDrafts.repliedAt} >= ${since})::int`,
      opens: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.openedAt} IS NOT NULL AND ${outreachDrafts.openedAt} >= ${since})::int`,
      bounces: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.bouncedAt} IS NOT NULL AND ${outreachDrafts.bouncedAt} >= ${since})::int`,
    })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.accountId, accountId),
        eq(outreachDrafts.facilityId, facilityId),
      ),
    );
  return {
    replies: row?.replies ?? 0,
    opens: row?.opens ?? 0,
    bounces: row?.bounces ?? 0,
  };
}

async function contactEngagementForAccount(
  accountId: string,
  contactId: string,
): Promise<EngagementCounts> {
  const since = lookbackDate();
  const [row] = await db
    .select({
      replies: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.repliedAt} IS NOT NULL AND ${outreachDrafts.repliedAt} >= ${since})::int`,
      opens: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.openedAt} IS NOT NULL AND ${outreachDrafts.openedAt} >= ${since})::int`,
      bounces: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.bouncedAt} IS NOT NULL AND ${outreachDrafts.bouncedAt} >= ${since})::int`,
    })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.accountId, accountId),
        eq(outreachDrafts.contactId, contactId),
      ),
    );
  return {
    replies: row?.replies ?? 0,
    opens: row?.opens ?? 0,
    bounces: row?.bounces ?? 0,
  };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Compute the global, tenant-agnostic facility score from objective signals
 * (CON filings, equipment urgency, depreciation flags, etc). Engagement is
 * NOT folded in here because engagement is tenant-specific.
 */
export async function computeFacilityScore(facilityId: string): Promise<number> {
  const sigs = await db
    .select()
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.facilityId, facilityId),
        eq(purchaseSignals.isActive, true),
      ),
    );

  let score = 0;
  for (const s of sigs) {
    const w = WEIGHTS[s.signalType] ?? 5;
    const conf = (s.confidence ?? 50) / 100;
    score += w * conf;
  }

  // Equipment urgency contribution
  const equip = await db
    .select()
    .from(equipmentRecords)
    .where(eq(equipmentRecords.facilityId, facilityId));
  for (const e of equip) {
    if (e.urgencyTier === "critical") score += 15;
    else if (e.urgencyTier === "high") score += 8;
    else if (e.urgencyTier === "medium") score += 3;
  }

  // Verified contact bonus
  const contacts = await db
    .select({ id: facilityContacts.id })
    .from(facilityContacts)
    .where(
      and(
        eq(facilityContacts.facilityId, facilityId),
        eq(facilityContacts.humanVerified, true),
      ),
    );
  if (contacts.length > 0) score += 5;

  return clampScore(score);
}

/**
 * Compute and persist the per-tenant engagement score for a single facility,
 * stored on `account_facilities.engagementScore`. Capped to a 0-100 range.
 */
export async function recomputeAccountFacilityEngagement(
  accountId: string,
  facilityId: string,
): Promise<number> {
  const eng = await facilityEngagementForAccount(accountId, facilityId);
  const delta =
    Math.min(eng.replies, 5) * REPLY_FACILITY_WEIGHT +
    Math.min(eng.opens, 10) * OPEN_FACILITY_WEIGHT +
    Math.min(eng.bounces, 10) * BOUNCE_FACILITY_WEIGHT;
  const score = clampScore(50 + delta);
  await db
    .update(accountFacilities)
    .set({ engagementScore: score, updatedAt: new Date() })
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        eq(accountFacilities.facilityId, facilityId),
      ),
    );
  return score;
}

/**
 * Compute and upsert the per-tenant engagement score for a single contact.
 */
export async function recomputeAccountContactEngagement(
  accountId: string,
  contactId: string,
): Promise<number> {
  const eng = await contactEngagementForAccount(accountId, contactId);
  const delta =
    Math.min(eng.replies, 3) * REPLY_CONTACT_WEIGHT +
    Math.min(eng.opens, 5) * OPEN_CONTACT_WEIGHT +
    Math.min(eng.bounces, 3) * BOUNCE_CONTACT_WEIGHT;
  const score = clampScore(50 + delta);
  await db
    .insert(accountContactEngagement)
    .values({
      accountId,
      contactId,
      engagementScore: score,
      repliesCount: eng.replies,
      opensCount: eng.opens,
      bouncesCount: eng.bounces,
    })
    .onConflictDoUpdate({
      target: [
        accountContactEngagement.accountId,
        accountContactEngagement.contactId,
      ],
      set: {
        engagementScore: score,
        repliesCount: eng.replies,
        opensCount: eng.opens,
        bouncesCount: eng.bounces,
        updatedAt: new Date(),
      },
    });
  return score;
}

async function recomputeAccountContactsForFacility(
  accountId: string,
  facilityId: string,
): Promise<void> {
  const rows = await db
    .select({ id: facilityContacts.id })
    .from(facilityContacts)
    .where(eq(facilityContacts.facilityId, facilityId));
  for (const r of rows) {
    await recomputeAccountContactEngagement(accountId, r.id);
  }
}

/**
 * Recompute the objective facility score for every facility, then refresh
 * per-tenant engagement scores for every (account, facility, contact) triple.
 */
export async function recomputeAllScores(): Promise<{ updated: number }> {
  const all = await db.select({ id: facilities.id }).from(facilities);
  let updated = 0;
  for (const f of all) {
    const newScore = await computeFacilityScore(f.id);
    await db
      .update(facilities)
      .set({ signalScore: newScore, updatedAt: new Date() })
      .where(eq(facilities.id, f.id));
    updated += 1;
  }

  // Per-tenant engagement refresh, scoped by accountId so tenants stay
  // isolated.
  const acctFacs = await db
    .select({
      accountId: accountFacilities.accountId,
      facilityId: accountFacilities.facilityId,
    })
    .from(accountFacilities);
  for (const af of acctFacs) {
    await recomputeAccountFacilityEngagement(af.accountId, af.facilityId);
    await recomputeAccountContactsForFacility(af.accountId, af.facilityId);
  }
  return { updated };
}

/**
 * Recompute the global score for one facility (objective signals only).
 * Engagement recompute is a separate, account-scoped call.
 */
export async function recomputeOne(facilityId: string): Promise<number> {
  const score = await computeFacilityScore(facilityId);
  await db
    .update(facilities)
    .set({ signalScore: score, updatedAt: new Date() })
    .where(eq(facilities.id, facilityId));
  return score;
}

/**
 * Webhook entry point. Recompute engagement for the (account, facility) pair
 * the webhook event belongs to, and refresh per-contact engagement under that
 * facility for the same account. Strictly tenant-scoped: never reads or
 * writes engagement for any other accountId.
 */
export async function recomputeEngagementForAccountFacility(
  accountId: string,
  facilityId: string,
): Promise<void> {
  await recomputeAccountFacilityEngagement(accountId, facilityId);
  await recomputeAccountContactsForFacility(accountId, facilityId);
}

// Re-export sql for callers
export { sql };
