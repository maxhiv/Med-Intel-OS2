/**
 * Territory service — evaluates a saved TerritoryFilter against the joined
 * app `facilities` + medintel warehouse, returning ranked, qualified
 * prospects for a sales rep's working list.
 *
 * The filter is intentionally a structured JSON object (stored on
 * `territories.filter`) so the planner UI can persist and re-run it without
 * a migration every time we add a knob.
 *
 * Buy-side filter (default):
 *   - geography:   states[] | zips[] | metros[] (CBSA names)
 *   - facility:    facilityTypes[] (STH/CAH/FQHC/RHC/LTCH/REH/IRF/IPF/SNF/ASC)
 *   - ownership:   privateEquity | reit | chain | holdingCompany | forProfit
 *   - financials:  minBeds | minTotalAssets | minNetPatientRevenue
 *   - cycle:       recentChow | aipInfraSpend (any active purchase_signals row)
 *   - service:     minOutpatientRevenue | minDischarges
 *   - scoreMin:    facilities.signal_score >= N
 *   - equipmentLineSlug: re-rank with the named EquipmentLineProfile rubric.
 *
 * Sell-side filter (view_kind = 'sell_side') OR adds:
 *   - sellerSideChow:       facility appears as CHOW seller
 *   - hcrisNetIncomeYoyDecline: latest year < previous year
 *   - hcrisCashYoyDecline:      latest year < previous year
 *   - acquisitionsInMetro:  >=2 CHOWs in the facility's CBSA within 24mo
 */
import { and, eq, gte, ilike, inArray, isNull, or, sql, desc, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  facilities,
  purchaseSignals,
  type Facility,
  medintelDimFacility,
  medintelBridgeNpiEnrollment,
  medintelFactCostReport,
  medintelFactChow,
} from "@workspace/db";
import { applyEquipmentLineRubric, type EquipmentLineRubric } from "./equipmentLineService";

// ─── Filter Zod schemas (also used by the API request validators) ───────────

export const ownershipFilterSchema = z.object({
  privateEquity: z.boolean().optional(),
  reit: z.boolean().optional(),
  chain: z.boolean().optional(),
  holdingCompany: z.boolean().optional(),
  forProfit: z.union([z.boolean(), z.literal("either")]).optional(),
});

export const financialSizeFilterSchema = z.object({
  minBeds: z.number().int().nonnegative().optional(),
  minTotalAssets: z.number().nonnegative().optional(),
  minNetPatientRevenue: z.number().nonnegative().optional(),
});

export const cycleFilterSchema = z.object({
  recentChow: z.boolean().optional(),
  aipInfraSpend: z.boolean().optional(),
  cmmiStateLaunch: z.boolean().optional(),
  psi11Outlier: z.boolean().optional(),
});

export const serviceMixFilterSchema = z.object({
  minOutpatientRevenue: z.number().nonnegative().optional(),
  minInpatientRevenue: z.number().nonnegative().optional(),
  minDischarges: z.number().int().nonnegative().optional(),
});

export const sellSideFilterSchema = z.object({
  sellerSideChow: z.boolean().optional(),
  hcrisNetIncomeYoyDecline: z.boolean().optional(),
  hcrisCashYoyDecline: z.boolean().optional(),
  acquisitionsInMetro: z.boolean().optional(),
});

export const territoryFilterSchema = z.object({
  states: z.array(z.string().length(2)).optional(),
  zips: z.array(z.string().min(3).max(10)).optional(),
  metros: z.array(z.string()).optional(),
  facilityTypes: z.array(z.string()).optional(),
  ownership: ownershipFilterSchema.optional(),
  financialSize: financialSizeFilterSchema.optional(),
  cycle: cycleFilterSchema.optional(),
  serviceMix: serviceMixFilterSchema.optional(),
  sellSide: sellSideFilterSchema.optional(),
  scoreMin: z.number().int().min(0).max(100).optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
  sortBy: z.enum(["score_desc", "score_asc", "name", "beds_desc", "revenue_desc"]).default("score_desc"),
  equipmentLineSlug: z.string().optional(),
});
export type TerritoryFilter = z.infer<typeof territoryFilterSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

type LatestCostReport = {
  facilityCcn: string;
  numberOfBeds: number | null;
  totalAssets: number | null;
  netPatientRevenue: number | null;
  outpatientRevenue: number | null;
  inpatientRevenue: number | null;
  totalDischargesAll: number | null;
  netIncome: number | null;
  cashOnHand: number | null;
  fiscalYearEnd: string | null;
};

/**
 * For each CCN, returns the most recent cost report + the previous one
 * (for YoY checks). Single query — DISTINCT ON keeps the join cheap.
 */
async function fetchCostReports(
  ccns: string[],
): Promise<{ latest: Map<string, LatestCostReport>; prior: Map<string, LatestCostReport> }> {
  if (ccns.length === 0) return { latest: new Map(), prior: new Map() };

  // Materialise per-CCN ordering once and pick rank 1 and 2.
  const rows = await db.execute(sql`
    WITH ranked AS (
      SELECT cr.*,
             ROW_NUMBER() OVER (
               PARTITION BY provider_ccn
               ORDER BY fiscal_year_end_date DESC NULLS LAST
             ) AS rk
        FROM medintel.fact_cost_report cr
       WHERE provider_ccn = ANY(${ccns}::text[])
    )
    SELECT
      provider_ccn,
      rk,
      number_of_beds,
      total_assets,
      net_patient_revenue,
      outpatient_revenue,
      inpatient_revenue,
      total_discharges_all,
      net_income,
      cash_on_hand_in_banks,
      fiscal_year_end_date
      FROM ranked
     WHERE rk <= 2
  `);

  const latest = new Map<string, LatestCostReport>();
  const prior = new Map<string, LatestCostReport>();
  for (const r of rows.rows as unknown as Array<Record<string, unknown>>) {
    const ccn = r.provider_ccn as string;
    const entry: LatestCostReport = {
      facilityCcn: ccn,
      numberOfBeds: r.number_of_beds == null ? null : Number(r.number_of_beds),
      totalAssets: r.total_assets == null ? null : Number(r.total_assets),
      netPatientRevenue: r.net_patient_revenue == null ? null : Number(r.net_patient_revenue),
      outpatientRevenue: r.outpatient_revenue == null ? null : Number(r.outpatient_revenue),
      inpatientRevenue: r.inpatient_revenue == null ? null : Number(r.inpatient_revenue),
      totalDischargesAll: r.total_discharges_all == null ? null : Number(r.total_discharges_all),
      netIncome: r.net_income == null ? null : Number(r.net_income),
      cashOnHand: r.cash_on_hand_in_banks == null ? null : Number(r.cash_on_hand_in_banks),
      fiscalYearEnd: (r.fiscal_year_end_date as string | null) ?? null,
    };
    const rk = Number(r.rk);
    if (rk === 1) latest.set(ccn, entry);
    else if (rk === 2) prior.set(ccn, entry);
  }
  return { latest, prior };
}

interface OwnershipSignals {
  privateEquity: Set<string>;
  reit: Set<string>;
  chain: Set<string>;
  holdingCompany: Set<string>;
}

async function fetchOwnershipSignals(facilityIds: string[]): Promise<OwnershipSignals> {
  const out: OwnershipSignals = {
    privateEquity: new Set(),
    reit: new Set(),
    chain: new Set(),
    holdingCompany: new Set(),
  };
  if (facilityIds.length === 0) return out;

  const rows = await db
    .select({
      facilityId: purchaseSignals.facilityId,
      signalType: purchaseSignals.signalType,
    })
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.isActive, true),
        inArray(purchaseSignals.facilityId, facilityIds),
        inArray(purchaseSignals.signalType, [
          "pe_takeover",
          "reit_takeover",
          "chain_acquisition",
          // hospital_operator is the legacy holding-company analog
          "hospital_operator",
        ] as const),
      ),
    );
  for (const r of rows) {
    if (r.signalType === "pe_takeover") out.privateEquity.add(r.facilityId);
    else if (r.signalType === "reit_takeover") out.reit.add(r.facilityId);
    else if (r.signalType === "chain_acquisition") out.chain.add(r.facilityId);
    else if (r.signalType === "hospital_operator") out.holdingCompany.add(r.facilityId);
  }
  return out;
}

async function fetchCycleSignals(
  facilityIds: string[],
): Promise<{
  recentChow: Set<string>;
  aipInfraSpend: Set<string>;
  cmmiStateLaunch: Set<string>;
  psi11Outlier: Set<string>;
}> {
  const out = {
    recentChow: new Set<string>(),
    aipInfraSpend: new Set<string>(),
    cmmiStateLaunch: new Set<string>(),
    psi11Outlier: new Set<string>(),
  };
  if (facilityIds.length === 0) return out;
  const rows = await db
    .select({
      facilityId: purchaseSignals.facilityId,
      signalType: purchaseSignals.signalType,
    })
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.isActive, true),
        inArray(purchaseSignals.facilityId, facilityIds),
        inArray(purchaseSignals.signalType, [
          "chow_recent",
          "aip_infra_spend",
          "cmmi_state_launch",
          "psi11_outlier",
        ] as const),
      ),
    );
  for (const r of rows) {
    if (r.signalType === "chow_recent") out.recentChow.add(r.facilityId);
    else if (r.signalType === "aip_infra_spend") out.aipInfraSpend.add(r.facilityId);
    else if (r.signalType === "cmmi_state_launch") out.cmmiStateLaunch.add(r.facilityId);
    else if (r.signalType === "psi11_outlier") out.psi11Outlier.add(r.facilityId);
  }
  return out;
}

/** Returns the set of CCNs that appear as sellers in fact_chow (any vintage). */
async function fetchSellerChowCcns(ccns: string[]): Promise<Set<string>> {
  if (ccns.length === 0) return new Set();
  const rows = await db
    .select({ ccn: medintelFactChow.ccnSeller })
    .from(medintelFactChow)
    .where(inArray(medintelFactChow.ccnSeller, ccns));
  return new Set(rows.map((r) => r.ccn).filter((v): v is string => Boolean(v)));
}

/**
 * Returns CBSA → number-of-CHOWs in the last 24 months. Caller picks
 * facilities whose CBSA has >= 2.
 */
async function fetchActiveMarkets(): Promise<Map<string, number>> {
  const since = new Date();
  since.setMonth(since.getMonth() - 24);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT cr.medicare_cbsa_number::text AS cbsa, COUNT(*)::int AS n
      FROM medintel.fact_chow ch
      JOIN medintel.fact_cost_report cr
        ON cr.provider_ccn = ch.ccn_buyer
     WHERE ch.effective_date >= ${sinceStr}
       AND cr.medicare_cbsa_number IS NOT NULL
     GROUP BY cr.medicare_cbsa_number
    HAVING COUNT(*) >= 2
  `);
  const out = new Map<string, number>();
  for (const r of rows.rows as Array<{ cbsa: string; n: number }>) {
    if (r.cbsa) out.set(String(r.cbsa), Number(r.n));
  }
  return out;
}

/**
 * Maps each app facility id → its medicare_cbsa_number (via CCN→cost_report).
 */
async function fetchFacilityCbsa(
  ccnToFacilityIds: Map<string, string[]>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ccns = Array.from(ccnToFacilityIds.keys());
  if (ccns.length === 0) return out;
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (provider_ccn)
           provider_ccn,
           medicare_cbsa_number::text AS cbsa
      FROM medintel.fact_cost_report
     WHERE provider_ccn = ANY(${ccns}::text[])
       AND medicare_cbsa_number IS NOT NULL
     ORDER BY provider_ccn, fiscal_year_end_date DESC NULLS LAST
  `);
  for (const r of rows.rows as Array<{ provider_ccn: string; cbsa: string | null }>) {
    if (!r.provider_ccn || !r.cbsa) continue;
    for (const fid of ccnToFacilityIds.get(r.provider_ccn) ?? []) out.set(fid, String(r.cbsa));
  }
  return out;
}

// ─── Result row ─────────────────────────────────────────────────────────────

export interface TerritoryFacility extends Facility {
  baseScore: number;
  equipmentScore: number | null;
  lineRationale: string[] | null;
  flags: {
    privateEquity: boolean;
    reit: boolean;
    chain: boolean;
    holdingCompany: boolean;
    recentChow: boolean;
    aipInfraSpend: boolean;
    sellerSideChow: boolean;
    hcrisNetIncomeYoyDecline: boolean;
    hcrisCashYoyDecline: boolean;
    inActiveMarket: boolean;
  };
  hcris: {
    fiscalYearEnd: string | null;
    beds: number | null;
    totalAssets: number | null;
    netPatientRevenue: number | null;
    netIncome: number | null;
    cashOnHand: number | null;
    netIncomePrior: number | null;
    cashOnHandPrior: number | null;
  } | null;
}

export interface TerritoryEvaluation {
  total: number;
  results: TerritoryFacility[];
}

// ─── Core ───────────────────────────────────────────────────────────────────

export async function evaluateTerritory(
  filter: TerritoryFilter,
  options: { viewKind?: "buy_side" | "sell_side"; rubric?: EquipmentLineRubric } = {},
): Promise<TerritoryEvaluation> {
  const viewKind = options.viewKind ?? "buy_side";

  // Step 1: app-side primary filter on `facilities`. Cheap and selective.
  const conds: SQL[] = [];
  if (filter.states && filter.states.length > 0) {
    conds.push(inArray(facilities.state, filter.states));
  }
  if (filter.zips && filter.zips.length > 0) {
    conds.push(inArray(facilities.zip, filter.zips));
  }
  if (filter.facilityTypes && filter.facilityTypes.length > 0) {
    conds.push(inArray(facilities.facilityType, filter.facilityTypes));
  }
  if (typeof filter.scoreMin === "number") {
    conds.push(gte(facilities.signalScore, filter.scoreMin));
  }
  if (filter.search && filter.search.trim() !== "") {
    conds.push(ilike(facilities.name, `%${filter.search.trim()}%`));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const baseRows = await db
    .select()
    .from(facilities)
    .where(where)
    .limit(Math.min(filter.limit * 4 + filter.offset, 2000)); // overfetch for downstream filtering

  if (baseRows.length === 0) return { total: 0, results: [] };

  const facilityIds = baseRows.map((f) => f.id);
  const ccnToFacilityIds = new Map<string, string[]>();
  for (const f of baseRows) {
    if (f.cmsId) {
      const arr = ccnToFacilityIds.get(f.cmsId) ?? [];
      arr.push(f.id);
      ccnToFacilityIds.set(f.cmsId, arr);
    }
  }
  const ccns = Array.from(ccnToFacilityIds.keys());

  const [ownership, cycle, costReports, sellerChowCcns, cbsaByFacility, activeMarkets] =
    await Promise.all([
      fetchOwnershipSignals(facilityIds),
      fetchCycleSignals(facilityIds),
      fetchCostReports(ccns),
      viewKind === "sell_side" || filter.sellSide?.sellerSideChow
        ? fetchSellerChowCcns(ccns)
        : Promise.resolve(new Set<string>()),
      filter.sellSide?.acquisitionsInMetro ? fetchFacilityCbsa(ccnToFacilityIds) : Promise.resolve(new Map<string, string>()),
      filter.sellSide?.acquisitionsInMetro ? fetchActiveMarkets() : Promise.resolve(new Map<string, number>()),
    ]);

  // ── Step 2: filter rows by all conditions
  const out: TerritoryFacility[] = [];
  for (const f of baseRows) {
    const ccn = f.cmsId ?? null;
    const latest = ccn ? costReports.latest.get(ccn) ?? null : null;
    const prior = ccn ? costReports.prior.get(ccn) ?? null : null;

    const flags = {
      privateEquity: ownership.privateEquity.has(f.id),
      reit: ownership.reit.has(f.id),
      chain: ownership.chain.has(f.id),
      holdingCompany: ownership.holdingCompany.has(f.id),
      recentChow: cycle.recentChow.has(f.id),
      aipInfraSpend: cycle.aipInfraSpend.has(f.id),
      sellerSideChow: ccn ? sellerChowCcns.has(ccn) : false,
      hcrisNetIncomeYoyDecline:
        latest?.netIncome != null && prior?.netIncome != null && latest.netIncome < prior.netIncome,
      hcrisCashYoyDecline:
        latest?.cashOnHand != null && prior?.cashOnHand != null && latest.cashOnHand < prior.cashOnHand,
      inActiveMarket: (() => {
        const cb = cbsaByFacility.get(f.id);
        return Boolean(cb && activeMarkets.has(cb));
      })(),
    };

    // ── Ownership filter
    if (filter.ownership) {
      if (filter.ownership.privateEquity === true && !flags.privateEquity) continue;
      if (filter.ownership.privateEquity === false && flags.privateEquity) continue;
      if (filter.ownership.reit === true && !flags.reit) continue;
      if (filter.ownership.reit === false && flags.reit) continue;
      if (filter.ownership.chain === true && !flags.chain) continue;
      if (filter.ownership.chain === false && flags.chain) continue;
      if (filter.ownership.holdingCompany === true && !flags.holdingCompany) continue;
    }
    // for_profit lives on facilities.ownership enum
    if (filter.ownership?.forProfit === true && f.ownership !== "for_profit") continue;
    if (filter.ownership?.forProfit === false && f.ownership === "for_profit") continue;

    // ── Financial size filter (requires latest cost report)
    if (filter.financialSize) {
      if (filter.financialSize.minBeds != null) {
        if (latest?.numberOfBeds == null || latest.numberOfBeds < filter.financialSize.minBeds) continue;
      }
      if (filter.financialSize.minTotalAssets != null) {
        if (latest?.totalAssets == null || latest.totalAssets < filter.financialSize.minTotalAssets) continue;
      }
      if (filter.financialSize.minNetPatientRevenue != null) {
        if (latest?.netPatientRevenue == null || latest.netPatientRevenue < filter.financialSize.minNetPatientRevenue) continue;
      }
    }

    // ── Cycle filter
    if (filter.cycle) {
      if (filter.cycle.recentChow && !flags.recentChow) continue;
      if (filter.cycle.aipInfraSpend && !flags.aipInfraSpend) continue;
      if (filter.cycle.cmmiStateLaunch && !cycle.cmmiStateLaunch.has(f.id)) continue;
      if (filter.cycle.psi11Outlier && !cycle.psi11Outlier.has(f.id)) continue;
    }

    // ── Service mix filter
    if (filter.serviceMix) {
      if (filter.serviceMix.minOutpatientRevenue != null) {
        if (latest?.outpatientRevenue == null || latest.outpatientRevenue < filter.serviceMix.minOutpatientRevenue) continue;
      }
      if (filter.serviceMix.minInpatientRevenue != null) {
        if (latest?.inpatientRevenue == null || latest.inpatientRevenue < filter.serviceMix.minInpatientRevenue) continue;
      }
      if (filter.serviceMix.minDischarges != null) {
        if (latest?.totalDischargesAll == null || latest.totalDischargesAll < filter.serviceMix.minDischarges) continue;
      }
    }

    // ── Sell-side gate (auto-applied for sell_side view + opt-in flags)
    const sellMode = viewKind === "sell_side";
    if (sellMode || filter.sellSide?.sellerSideChow) {
      if (sellMode && filter.sellSide?.sellerSideChow !== false && !flags.sellerSideChow) {
        // sell-side default requires either seller-CHOW or HCRIS decline; check decline next
      } else if (filter.sellSide?.sellerSideChow === true && !flags.sellerSideChow) {
        continue;
      }
    }
    if (filter.sellSide?.hcrisNetIncomeYoyDecline === true && !flags.hcrisNetIncomeYoyDecline) continue;
    if (filter.sellSide?.hcrisCashYoyDecline === true && !flags.hcrisCashYoyDecline) continue;
    if (filter.sellSide?.acquisitionsInMetro === true && !flags.inActiveMarket) continue;

    if (sellMode) {
      // For a sell-side view, the facility must satisfy AT LEAST ONE distress
      // signal — otherwise it doesn't belong here.
      const distress =
        flags.sellerSideChow ||
        flags.hcrisNetIncomeYoyDecline ||
        flags.hcrisCashYoyDecline ||
        flags.inActiveMarket;
      if (!distress) continue;
    }

    const baseScore = f.signalScore ?? 0;
    const equip = options.rubric
      ? applyEquipmentLineRubric(options.rubric, {
          facility: f,
          flags,
          hcris: latest,
        })
      : null;

    out.push({
      ...f,
      baseScore,
      equipmentScore: equip ? equip.score : null,
      lineRationale: equip ? equip.rationale : null,
      flags,
      hcris: latest
        ? {
            fiscalYearEnd: latest.fiscalYearEnd,
            beds: latest.numberOfBeds,
            totalAssets: latest.totalAssets,
            netPatientRevenue: latest.netPatientRevenue,
            netIncome: latest.netIncome,
            cashOnHand: latest.cashOnHand,
            netIncomePrior: prior?.netIncome ?? null,
            cashOnHandPrior: prior?.cashOnHand ?? null,
          }
        : null,
    });
  }

  // ── Sort
  out.sort((a, b) => {
    switch (filter.sortBy) {
      case "name":
        return a.name.localeCompare(b.name);
      case "score_asc":
        return (a.equipmentScore ?? a.baseScore) - (b.equipmentScore ?? b.baseScore);
      case "beds_desc":
        return (b.hcris?.beds ?? 0) - (a.hcris?.beds ?? 0);
      case "revenue_desc":
        return (b.hcris?.netPatientRevenue ?? 0) - (a.hcris?.netPatientRevenue ?? 0);
      case "score_desc":
      default:
        return (b.equipmentScore ?? b.baseScore) - (a.equipmentScore ?? a.baseScore);
    }
  });

  const total = out.length;
  const sliced = out.slice(filter.offset, filter.offset + filter.limit);
  return { total, results: sliced };
}

// Silence imports kept for future variants.
void or;
void isNull;
void desc;
void medintelDimFacility;
void medintelBridgeNpiEnrollment;
void medintelFactCostReport;
