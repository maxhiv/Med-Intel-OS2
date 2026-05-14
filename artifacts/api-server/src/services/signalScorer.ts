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

// ─── Tier weights ────────────────────────────────────────────────────────────

// Tier 1 — direct buying intent
const TIER1_SIGNALS = new Set([
  "con_filed",
  "con_approved",
  "bond_issued",
  "rfp_posted",
  "hcris_depreciation_spike",
]);

// Tier 2 — supporting context
const TIER2_SIGNALS = new Set([
  "equipment_age_7yr",
  "high_utilization",
  "grant_awarded",
  "clinical_trial",
]);

// Tier 3 — enrichment
const TIER3_SIGNALS = new Set([
  "adverse_event_spike",
  "sec_capex_flag",
  "depreciation_flag",
  "eol_equipment",
  "fiscal_year_end",
  "bond_issuance",
  "accreditation_renewal",
  "compliance_citation",
  "construction_permit",
  "leadership_change",
  "service_line_expansion",
  "job_posting",
  "news_expansion",
  "nih_grant",
]);

const WEIGHTS: Record<string, number> = {
  // Tier 1
  con_filed: 35,
  con_approved: 40,
  bond_issued: 35,
  rfp_posted: 40,
  hcris_depreciation_spike: 25,
  // Tier 2
  equipment_age_7yr: 20,
  high_utilization: 15,
  grant_awarded: 25,
  clinical_trial: 15,
  // Tier 3
  adverse_event_spike: 10,
  sec_capex_flag: 18,
  // Legacy / kept for backward compat
  depreciation_flag: 12,
  eol_equipment: 12,
  bond_issuance: 8,
  construction_permit: 8,
  leadership_change: 6,
  service_line_expansion: 8,
  job_posting: 4,
  news_expansion: 4,
  accreditation_renewal: 5,
  compliance_citation: 4,
  nih_grant: 6,
  fiscal_year_end: 5,
};

// ─── Engagement constants ─────────────────────────────────────────────────────

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
  return { replies: row?.replies ?? 0, opens: row?.opens ?? 0, bounces: row?.bounces ?? 0 };
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
  return { replies: row?.replies ?? 0, opens: row?.opens ?? 0, bounces: row?.bounces ?? 0 };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ─── Signal breakdown ─────────────────────────────────────────────────────────

export interface SignalBreakdown {
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  crossSourceBonuses: string[];
  topSignals: Array<{ type: string; detectedAt: Date | null; confidence: number }>;
}

export async function computeSignalBreakdown(
  facilityId: string,
): Promise<SignalBreakdown> {
  const sigs = await db
    .select()
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.facilityId, facilityId),
        eq(purchaseSignals.isActive, true),
      ),
    );

  const typeSet = new Set(sigs.map((s) => s.signalType));

  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;
  for (const s of sigs) {
    if (TIER1_SIGNALS.has(s.signalType)) tier1Count++;
    else if (TIER2_SIGNALS.has(s.signalType)) tier2Count++;
    else tier3Count++;
  }

  const crossSourceBonuses: string[] = [];
  if (typeSet.has("con_filed") && typeSet.has("bond_issued"))
    crossSourceBonuses.push("CON + Bond Match");
  if (typeSet.has("hcris_depreciation_spike") && typeSet.has("con_filed"))
    crossSourceBonuses.push("Depreciation + CON Match");
  if (typeSet.has("high_utilization") && typeSet.has("equipment_age_7yr"))
    crossSourceBonuses.push("High Utilization + Equipment Age");
  if (typeSet.has("rfp_posted") && sigs.some((s) => s.source === "usa_spending"))
    crossSourceBonuses.push("RFP + Prior Award Match");

  const topSignals = sigs
    .sort((a, b) => {
      const wa = WEIGHTS[a.signalType] ?? 0;
      const wb = WEIGHTS[b.signalType] ?? 0;
      return wb - wa;
    })
    .slice(0, 3)
    .map((s) => ({
      type: s.signalType,
      detectedAt: s.detectedAt,
      confidence: s.confidence ?? 50,
    }));

  return { tier1Count, tier2Count, tier3Count, crossSourceBonuses, topSignals };
}

// ─── Core score computation ───────────────────────────────────────────────────

/**
 * Compute the global, tenant-agnostic facility score from objective signals.
 * Includes cross-source bonuses defined in the CMX spec.
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

  const typeSet = new Set(sigs.map((s) => s.signalType));

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

  // Cross-source bonuses
  if (typeSet.has("con_filed") && typeSet.has("bond_issued")) score += 15;
  if (typeSet.has("hcris_depreciation_spike") && typeSet.has("con_filed")) score += 10;
  if (typeSet.has("high_utilization") && typeSet.has("equipment_age_7yr")) score += 8;
  if (typeSet.has("rfp_posted") && sigs.some((s) => s.source === "usa_spending")) score += 12;

  return clampScore(score);
}

// ─── Engagement scoring ───────────────────────────────────────────────────────

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
      target: [accountContactEngagement.accountId, accountContactEngagement.contactId],
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

export async function recomputeOne(facilityId: string): Promise<number> {
  const score = await computeFacilityScore(facilityId);
  await db
    .update(facilities)
    .set({ signalScore: score, updatedAt: new Date() })
    .where(eq(facilities.id, facilityId));
  return score;
}

export async function recomputeEngagementForAccountFacility(
  accountId: string,
  facilityId: string,
): Promise<void> {
  await recomputeAccountFacilityEngagement(accountId, facilityId);
  await recomputeAccountContactsForFacility(accountId, facilityId);
}

export { sql };
