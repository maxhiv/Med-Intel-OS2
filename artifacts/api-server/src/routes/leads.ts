import { Router, type IRouter } from "express";
import { eq, and, inArray, gte, desc } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  facilityContacts,
  accountFacilities,
  conFilings,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";

const router: IRouter = Router();

const TIER_A_APPROVAL = new Set(["con_approved", "rfp_posted"]);
const TIER_1_BUDGET = new Set(["bond_issuance", "bond_issued", "grant_awarded", "nih_grant"]);
const TIER_1_INTENT = new Set(["con_filed", "con_approved", "rfp_posted", ...TIER_1_BUDGET]);
const TIER_2 = new Set([
  "hcris_depreciation_spike",
  "high_utilization",
  "eol_equipment",
  "adverse_event_spike",
  "clinical_trial",
  "510k_clearance_old",
  "fiscal_year_end",
]);

function computeTier(types: string[]): "A" | "B" | "C" {
  const s = new Set(types);
  const hasCon = s.has("con_filed") || s.has("con_approved");
  const hasBudget = s.has("bond_issuance") || s.has("bond_issued") || s.has("grant_awarded") || s.has("nih_grant");
  const hasApproval = [...s].some((t) => TIER_A_APPROVAL.has(t));

  if (hasApproval && hasBudget) return "A";
  if (hasCon && hasBudget) return "A";
  if (s.has("rfp_posted")) return "A";
  if (hasCon || (hasBudget && types.some((t) => TIER_2.has(t)))) return "B";
  if (types.some((t) => TIER_1_INTENT.has(t) || TIER_2.has(t))) return "C";
  return "C";
}

function computeRecommendedAction(types: string[]): string {
  const s = new Set(types);
  const hasBudget = s.has("bond_issuance") || s.has("bond_issued") || s.has("grant_awarded") || s.has("nih_grant");

  if (s.has("rfp_posted")) return "Active RFP — respond within 48 hours or lose.";
  if (s.has("con_approved") && hasBudget) return "URGENT: Capital confirmed + CON approved. Call this week.";
  if (s.has("con_approved")) return "CON approved — outreach window is now. 30-day close cycle.";
  if (s.has("con_filed") && hasBudget) return "Pre-position: CON pending with capital secured. Reach out now.";
  if (hasBudget) return "Capital available. Identify equipment need in discovery.";
  if (s.has("eol_equipment") && s.has("high_utilization")) return "Throughput pressure + aging equipment. ROI conversation.";
  if (s.has("adverse_event_spike")) return "Equipment failures on record. Empathy-led replacement outreach.";
  if (s.has("fiscal_year_end")) return "FYE approaching — qualify budget before close.";
  return "Relationship building. Monitor for Tier 1 signals.";
}

router.get("/leads", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const minScore = Math.max(Number(req.query.minScore) || 40, 0);
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const stateFilter =
    typeof req.query.state === "string" && req.query.state.length === 2
      ? req.query.state.toUpperCase()
      : "";
  const tierFilter =
    typeof req.query.tierFilter === "string" && ["A", "B", "C"].includes(req.query.tierFilter)
      ? (req.query.tierFilter as "A" | "B" | "C")
      : null;

  const owned = await db
    .select({ id: accountFacilities.facilityId })
    .from(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  const facIds = owned.map((o) => o.id);

  if (facIds.length === 0) {
    res.json({ leads: [], total: 0, limit, offset });
    return;
  }

  const facConds = [inArray(facilities.id, facIds), gte(facilities.signalScore, minScore)];
  if (stateFilter) facConds.push(eq(facilities.state, stateFilter));

  const facRows = await db
    .select()
    .from(facilities)
    .where(and(...facConds))
    .orderBy(desc(facilities.signalScore))
    .limit(200);

  if (facRows.length === 0) {
    res.json({ leads: [], total: 0, limit, offset });
    return;
  }

  const facilityIds = facRows.map((f) => f.id);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 24);

  const [signals, contacts, cons] = await Promise.all([
    db
      .select()
      .from(purchaseSignals)
      .where(and(inArray(purchaseSignals.facilityId, facilityIds), gte(purchaseSignals.detectedAt, cutoff)))
      .orderBy(desc(purchaseSignals.detectedAt)),
    db
      .select()
      .from(facilityContacts)
      .where(inArray(facilityContacts.facilityId, facilityIds))
      .orderBy(desc(facilityContacts.buyingAuthorityScore))
      .limit(facilityIds.length * 5),
    db
      .select()
      .from(conFilings)
      .where(inArray(conFilings.facilityId, facilityIds))
      .orderBy(desc(conFilings.filingDate))
      .limit(facilityIds.length),
  ]);

  const sigsByFac = new Map<string, typeof signals>();
  for (const s of signals) {
    if (!s.facilityId) continue;
    const arr = sigsByFac.get(s.facilityId) ?? [];
    arr.push(s);
    sigsByFac.set(s.facilityId, arr);
  }

  const contactsByFac = new Map<string, typeof contacts>();
  for (const c of contacts) {
    const arr = contactsByFac.get(c.facilityId) ?? [];
    arr.push(c);
    contactsByFac.set(c.facilityId, arr);
  }

  const conByFac = new Map<string, (typeof cons)[0]>();
  for (const con of cons) {
    if (con.facilityId && !conByFac.has(con.facilityId)) {
      conByFac.set(con.facilityId, con);
    }
  }

  const allLeads = facRows
    .map((fac) => {
      const facSigs = sigsByFac.get(fac.id) ?? [];
      const signalTypes = facSigs.map((s) => s.signalType as string);
      const tier = computeTier(signalTypes);
      const recommendedAction = computeRecommendedAction(signalTypes);

      const topSignals = [...facSigs]
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3)
        .map((s) => ({
          signalType: s.signalType,
          signalDate: s.detectedAt,
          confidence: s.confidence,
          source: s.source,
          metadata: s.metadata,
        }));

      const facContacts = (contactsByFac.get(fac.id) ?? []).slice(0, 3).map((c) => ({
        id: c.id,
        name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
        title: c.title,
        email: c.email,
        phone: c.phone,
        buyingAuthorityScore: c.buyingAuthorityScore,
      }));

      const latestCon = conByFac.get(fac.id) ?? null;
      const tier1Count = signalTypes.filter((t) => TIER_1_INTENT.has(t)).length;
      const tier2Count = signalTypes.filter((t) => TIER_2.has(t)).length;

      return {
        facilityId: fac.id,
        facilityName: fac.name,
        city: fac.city,
        state: fac.state,
        facilityType: fac.facilityType,
        signalScore: fac.signalScore ?? 0,
        leadTier: tier,
        recommendedAction,
        topSignals,
        signalBreakdown: { tier1Count, tier2Count, total: facSigs.length },
        contacts: facContacts,
        latestConFiling: latestCon
          ? {
              status: latestCon.status,
              modality: latestCon.modality,
              requestedAmount: latestCon.requestedAmount,
              filingDate: latestCon.filingDate,
              filingUrl: latestCon.filingUrl,
            }
          : null,
      };
    })
    .filter((lead) => !tierFilter || lead.leadTier === tierFilter);

  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const lead of allLeads) tierCounts[lead.leadTier]++;

  const total = allLeads.length;
  const paginated = allLeads.slice(offset, offset + limit);

  res.json({ leads: paginated, total, limit, offset, tierCounts });
});

export default router;
