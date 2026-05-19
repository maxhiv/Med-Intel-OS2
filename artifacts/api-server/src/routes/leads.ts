/**
 * GET /leads — returns paginated lead cards for the current account.
 *
 * Each card includes: tier (A/B/C), recommended action, top signals,
 * cross-source bonus matches, contacts, and FYE timing fields.
 */
import { Router, type IRouter } from "express";
import { eq, and, gte, inArray, sql, desc, exists } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  facilityContacts,
  accountFacilities,
  equipmentRecords,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { computeTimingBonus, CROSS_SOURCE_BONUS_RULES } from "../services/signalScorer";

const router: IRouter = Router();

// ─── Tier logic ───────────────────────────────────────────────────────────────

type LeadTier = "A" | "B" | "C";

function computeTier(score: number): LeadTier {
  if (score >= 70) return "A";
  if (score >= 50) return "B";
  return "C";
}

function computeRecommendedAction(
  score: number,
  signalTypes: Set<string>,
): { label: string; urgency: "high" | "medium" | "low" } {
  if (score >= 70) {
    if (signalTypes.has("con_approved") || signalTypes.has("rfp_posted")) {
      return { label: "Schedule Discovery Call — Active procurement window", urgency: "high" };
    }
    if (signalTypes.has("bond_issued") || signalTypes.has("bond_issuance")) {
      return { label: "Contact CFO/Buyer — Capital approved", urgency: "high" };
    }
    if (signalTypes.has("con_filed")) {
      return { label: "Reach out now — CON filed, decision approaching", urgency: "high" };
    }
    return { label: "Prioritize outreach — high-intent signals detected", urgency: "high" };
  }
  if (score >= 50) {
    if (signalTypes.has("hcris_depreciation_spike")) {
      return { label: "Send Equipment ROI Overview + Depreciation Report", urgency: "medium" };
    }
    return { label: "Send Equipment ROI Overview", urgency: "medium" };
  }
  return { label: "Enroll in Drip Nurture Sequence", urgency: "low" };
}

function budgetWindowStatus(daysUntil: number | null): string {
  if (daysUntil === null) return "unknown";
  if (daysUntil <= 30) return "closing";
  if (daysUntil <= 90) return "active";
  if (daysUntil <= 180) return "approaching";
  return "open";
}

export function daysUntilFYE(fiscalYearEndMonth: number | null | undefined): number | null {
  if (!fiscalYearEndMonth || fiscalYearEndMonth < 1 || fiscalYearEndMonth > 12) return null;
  const now = new Date();
  const currentYear = now.getFullYear();
  // Match computeTimingBonus: use end-of-day on the last day of the FYE month.
  let fyeDate = new Date(currentYear, fiscalYearEndMonth, 0, 23, 59, 59, 999);
  if (fyeDate < now) {
    fyeDate = new Date(currentYear + 1, fiscalYearEndMonth, 0, 23, 59, 59, 999);
  }
  return Math.round((fyeDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── GET /leads ───────────────────────────────────────────────────────────────

router.get("/leads", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;

  const minScore = Math.max(0, parseInt(String(req.query.minScore ?? "40"), 10));
  const tierFilter = String(req.query.tierFilter ?? "").toUpperCase() as LeadTier | "";
  const stateFilter = String(req.query.state ?? "").toUpperCase().slice(0, 2) || null;
  const equipmentTypeFilter = (req.query.equipmentType as string | undefined) || null;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10));

  // Compute effective score bounds based on tier filter — all bounds go into SQL
  // so that COUNT and paginated rows see the exact same predicate.
  let effectiveMinScore = minScore;
  let tierUpperBound: ReturnType<typeof sql<boolean>> | undefined;
  if (tierFilter === "A") {
    effectiveMinScore = Math.max(minScore, 70);
    // A has no upper bound
  } else if (tierFilter === "B") {
    effectiveMinScore = Math.max(minScore, 50);
    tierUpperBound = sql<boolean>`${facilities.signalScore} < 70`;
  } else if (tierFilter === "C") {
    effectiveMinScore = Math.max(minScore, 40);
    tierUpperBound = sql<boolean>`${facilities.signalScore} < 50`;
  }

  // Shared WHERE predicate — all filters including tier bounds, equipment
  // EXISTS, and state are resolved in SQL before ORDER BY / LIMIT / OFFSET.
  const whereClause = and(
    eq(accountFacilities.accountId, accountId),
    gte(facilities.signalScore, effectiveMinScore),
    tierUpperBound,
    stateFilter ? eq(facilities.state, stateFilter as "IL") : undefined,
    equipmentTypeFilter
      ? exists(
          db
            .select({ one: sql`1` })
            .from(equipmentRecords)
            .where(
              and(
                eq(equipmentRecords.facilityId, facilities.id),
                eq(equipmentRecords.modality, equipmentTypeFilter),
              ),
            ),
        )
      : undefined,
  );

  // True total for the full filtered set (no limit/offset).
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(facilities)
    .innerJoin(accountFacilities, eq(accountFacilities.facilityId, facilities.id))
    .where(whereClause);

  const total = countRow?.count ?? 0;

  if (total === 0) {
    res.json({ leads: [], total: 0, offset, limit });
    return;
  }

  // Paginated facility rows — same filters, now with limit/offset.
  const rows = await db
    .select({
      id: facilities.id,
      name: facilities.name,
      city: facilities.city,
      state: facilities.state,
      facilityType: facilities.facilityType,
      systemName: facilities.systemName,
      parentSystemId: facilities.parentSystemId,
      signalScore: facilities.signalScore,
      fiscalYearEndMonth: facilities.fiscalYearEndMonth,
      fiscalYearEndSource: facilities.fiscalYearEndSource,
      beds: facilities.beds,
      ownership: facilities.ownership,
    })
    .from(facilities)
    .innerJoin(accountFacilities, eq(accountFacilities.facilityId, facilities.id))
    .where(whereClause)
    .orderBy(desc(facilities.signalScore), desc(accountFacilities.dealScore))
    .limit(limit)
    .offset(offset);

  if (rows.length === 0) {
    res.json({ leads: [], total, offset, limit });
    return;
  }

  const facilityIds = rows.map((r) => r.id);

  // Batch-fetch all active signals
  const allSigs = await db
    .select()
    .from(purchaseSignals)
    .where(and(inArray(purchaseSignals.facilityId, facilityIds), eq(purchaseSignals.isActive, true)));

  const sigsByFacility = new Map<string, typeof allSigs>();
  for (const sig of allSigs) {
    if (!sigsByFacility.has(sig.facilityId)) sigsByFacility.set(sig.facilityId, []);
    sigsByFacility.get(sig.facilityId)!.push(sig);
  }

  // Batch-fetch contacts sorted by buying authority
  const allContacts = await db
    .select({
      id: facilityContacts.id,
      facilityId: facilityContacts.facilityId,
      firstName: facilityContacts.firstName,
      lastName: facilityContacts.lastName,
      title: facilityContacts.title,
      email: facilityContacts.email,
      phone: facilityContacts.phone,
      buyingAuthorityScore: facilityContacts.buyingAuthorityScore,
      humanVerified: facilityContacts.humanVerified,
    })
    .from(facilityContacts)
    .where(inArray(facilityContacts.facilityId, facilityIds))
    .orderBy(desc(facilityContacts.buyingAuthorityScore));

  const contactsByFacility = new Map<string, typeof allContacts>();
  for (const c of allContacts) {
    if (!contactsByFacility.has(c.facilityId)) contactsByFacility.set(c.facilityId, []);
    if (contactsByFacility.get(c.facilityId)!.length < 3) {
      contactsByFacility.get(c.facilityId)!.push(c);
    }
  }

  const SIGNAL_WEIGHTS: Record<string, number> = {
    con_approved: 40, rfp_posted: 40, con_filed: 35, bond_issued: 35,
    hcris_depreciation_spike: 25, grant_awarded: 25, equipment_age_7yr: 20,
    high_utilization: 15, clinical_trial: 15, sec_capex_flag: 18,
    system_signal_propagated: 15,
  };

  const leads = rows.map((f) => {
    const score = f.signalScore ?? 0;
    const sigs = sigsByFacility.get(f.id) ?? [];
    const typeSet = new Set(sigs.map((s) => s.signalType));
    const tier = computeTier(score);
    const { label: recommendedAction, urgency } = computeRecommendedAction(score, typeSet);
    const days = daysUntilFYE(f.fiscalYearEndMonth);
    const timingBonus = computeTimingBonus(f.fiscalYearEndMonth);

    // Top 3 signals by weight
    const topSignals = sigs
      .sort((a, b) => (SIGNAL_WEIGHTS[b.signalType] ?? 0) - (SIGNAL_WEIGHTS[a.signalType] ?? 0))
      .slice(0, 3)
      .map((s) => ({ type: s.signalType, detectedAt: s.detectedAt, confidence: s.confidence ?? 50 }));

    // Cross-source matches — driven by the shared CROSS_SOURCE_BONUS_RULES matrix
    const crossSourceMatches: string[] = CROSS_SOURCE_BONUS_RULES
      .filter((r) => r.matches(typeSet, sigs))
      .map((r) => r.label);

    return {
      facilityId: f.id,
      name: f.name,
      city: f.city,
      state: f.state,
      facilityType: f.facilityType,
      systemName: f.systemName,
      parentSystemId: f.parentSystemId,
      beds: f.beds,
      ownership: f.ownership,
      score,
      tier,
      recommendedAction,
      urgency,
      topSignals,
      crossSourceMatches,
      contacts: contactsByFacility.get(f.id) ?? [],
      fye: {
        month: f.fiscalYearEndMonth,
        source: f.fiscalYearEndSource,
        daysUntil: days,
        timingBonus,
        budgetWindowStatus: budgetWindowStatus(days),
      },
    };
  });

  res.json({ leads, total, offset, limit });
});

// ─── GET /leads/summary ────────────────────────────────────────────────────────

router.get("/leads/summary", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;

  const [tierA] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(facilities)
    .innerJoin(accountFacilities, eq(accountFacilities.facilityId, facilities.id))
    .where(and(eq(accountFacilities.accountId, accountId), gte(facilities.signalScore, 70)));

  const [tierB] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(facilities)
    .innerJoin(accountFacilities, eq(accountFacilities.facilityId, facilities.id))
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        gte(facilities.signalScore, 50),
        sql`${facilities.signalScore} < 70`,
      ),
    );

  const [tierC] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(facilities)
    .innerJoin(accountFacilities, eq(accountFacilities.facilityId, facilities.id))
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        gte(facilities.signalScore, 40),
        sql`${facilities.signalScore} < 50`,
      ),
    );

  res.json({
    tierA: tierA?.count ?? 0,
    tierB: tierB?.count ?? 0,
    tierC: tierC?.count ?? 0,
  });
});

export default router;
