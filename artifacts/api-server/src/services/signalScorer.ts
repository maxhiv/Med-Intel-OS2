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
  "system_signal_propagated",
  "financial_health",
  "capital_investment",
  "workforce_expansion",
  "hospital_operator",
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
  system_signal_propagated: 15,
  financial_health: 8,
  capital_investment: 18,
  workforce_expansion: 6,
  hospital_operator: 10,
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

  const crossSourceBonuses: string[] = CROSS_SOURCE_BONUS_RULES
    .filter((r) => r.matches(typeSet, sigs))
    .map((r) => r.label);

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

// ─── Cross-source bonus matrix ────────────────────────────────────────────────

/**
 * Named cross-source bonus rules (Section 9 of the CMX spec).
 * Exported so the /leads endpoint can surface matched label strings.
 * Each rule declares: the condition predicate, the human-readable label,
 * and the integer points added to the facility score.
 */
export interface CrossSourceBonusRule {
  label: string;
  points: number;
  matches(typeSet: Set<string>, sigs: Array<{ source: string }>): boolean;
}

export const CROSS_SOURCE_BONUS_RULES: CrossSourceBonusRule[] = [
  {
    label: "CON Approved + Capital Confirmed",
    points: 20,
    matches: (t) => t.has("con_approved") && (t.has("bond_issued") || t.has("bond_issuance")),
  },
  {
    label: "CON Filed + Bond Financing",
    points: 15,
    matches: (t) => t.has("con_filed") && (t.has("bond_issued") || t.has("bond_issuance")),
  },
  {
    label: "RFP + Prior Award Match",
    points: 12,
    matches: (t, sigs) => t.has("rfp_posted") && sigs.some((s) => s.source === "usa_spending"),
  },
  {
    label: "Grant + CON Expansion",
    points: 12,
    matches: (t) => t.has("grant_awarded") && (t.has("con_filed") || t.has("con_approved")),
  },
  {
    label: "Depreciation Spike + CON Activity",
    points: 10,
    matches: (t) => t.has("hcris_depreciation_spike") && (t.has("con_filed") || t.has("con_approved")),
  },
  {
    label: "High Utilization + CON Activity",
    points: 10,
    matches: (t) => t.has("high_utilization") && (t.has("con_filed") || t.has("con_approved")),
  },
  {
    label: "High Utilization + EOL Equipment",
    points: 8,
    matches: (t) => t.has("high_utilization") && (t.has("eol_equipment") || t.has("equipment_age_7yr")),
  },
  {
    label: "Adverse Events + Aging Equipment",
    points: 8,
    matches: (t) => t.has("adverse_event_spike") && t.has("hcris_depreciation_spike"),
  },
  {
    label: "Clinical Trial + Grant Award",
    points: 8,
    matches: (t) => t.has("clinical_trial") && t.has("grant_awarded"),
  },
  {
    // "System Propagated + Direct" — any Tier 1 buying-intent signal co-present.
    label: "System-Wide Capital Signal",
    points: 10,
    matches: (t) =>
      t.has("system_signal_propagated") &&
      (t.has("con_filed") ||
        t.has("con_approved") ||
        t.has("bond_issued") ||
        t.has("bond_issuance") ||
        t.has("rfp_posted") ||
        t.has("hcris_depreciation_spike")),
  },
];

// ─── FYE timing bonus ─────────────────────────────────────────────────────────

/**
 * Returns a 0–20 bonus based on how close the facility is to its fiscal year
 * end. Budget decisions accelerate in the 90 days before close.
 *   ≤ 30 days → +20   ≤ 60 days → +15   ≤ 90 days → +10   ≤ 180 days → +5
 */
export function computeTimingBonus(fiscalYearEndMonth: number | null | undefined): number {
  if (!fiscalYearEndMonth || fiscalYearEndMonth < 1 || fiscalYearEndMonth > 12) return 0;
  const now = new Date();
  const currentYear = now.getFullYear();
  // Use end-of-day on the last day of the fiscal year end month so the entire
  // FYE day is counted as "not yet passed" (day 0 of next month = last day of target month).
  let fyeDate = new Date(currentYear, fiscalYearEndMonth, 0, 23, 59, 59, 999);
  if (fyeDate < now) {
    // The FYE day itself is fully over — target next year's close.
    fyeDate = new Date(currentYear + 1, fiscalYearEndMonth, 0, 23, 59, 59, 999);
  }
  const daysUntil = Math.round((fyeDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (daysUntil <= 30) return 20;
  if (daysUntil <= 60) return 15;
  if (daysUntil <= 90) return 10;
  if (daysUntil <= 180) return 5;
  return 0;
}

// ─── Core score computation ───────────────────────────────────────────────────

/**
 * Compute the global, tenant-agnostic facility score from objective signals.
 * Includes cross-source bonuses and FYE timing bonus defined in the CMX spec.
 */
export async function computeFacilityScore(facilityId: string): Promise<number> {
  const [facility] = await db
    .select({ fiscalYearEndMonth: facilities.fiscalYearEndMonth })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);

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

  // Cross-source bonuses — driven by the shared CROSS_SOURCE_BONUS_RULES matrix
  for (const rule of CROSS_SOURCE_BONUS_RULES) {
    if (rule.matches(typeSet, sigs)) score += rule.points;
  }

  // FYE timing bonus — budget decisions accelerate near fiscal year close
  score += computeTimingBonus(facility?.fiscalYearEndMonth);

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
