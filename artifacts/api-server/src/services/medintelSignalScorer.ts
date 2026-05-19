/**
 * Medintel signal scorer — turns warehouse facts into actionable purchase
 * signals. Runs daily, idempotent: every signal is keyed on a stable
 * `signal_value` so re-runs don't duplicate rows.
 *
 * Source-of-truth for rule weights and tier classification lives in
 * `signalScorer.ts`; this service ONLY emits signal rows, then the recompute
 * step picks them up.
 *
 * Rules emitted (one purchase_signals row per facility/rule):
 *   - chow_recent        Hospital/SNF change of ownership in last 18 months
 *   - pe_takeover        PE firm recorded as owner in PECOS
 *   - reit_takeover      REIT recorded as owner in PECOS
 *   - chain_acquisition  Chain-home-office owner controls 5+ facilities
 *   - aip_infra_spend    ACO with AIP dollars in an infra spend category
 *   - cmmi_state_launch  Active CMMI model in this facility's state
 *   - psi11_outlier      Hospital's PSI-11 rate above the national average
 */
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  type InsertSignal,
  medintelFactChow,
  medintelFactOwnership,
  medintelDimOwner,
  medintelFactAipSpending,
  medintelDimAco,
  medintelFactAsmParticipant,
  medintelDimCmmiModel,
  medintelDimFacility,
  medintelBridgeNpiEnrollment,
  medintelFactPsi11,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { listLinkableFacilities } from "./medintelRepo";

const SOURCE = "medintel_warehouse";
const CHOW_LOOKBACK_MONTHS = 18;

// ── Match helpers ────────────────────────────────────────────────────────────

/**
 * Build a CCN → facilityId index and an NPI → facilityId index from
 * app-side `facilities`, then resolve each to a medintel `enrollment_id` via
 * the warehouse bridges. Returns the inverse maps the rules below consume.
 */
interface FacilityIndex {
  byEnrollmentId: Map<string, string[]>; // enrollmentId → facilityId(s)
  byCcn: Map<string, string[]>; // CCN → facilityId(s)
  byNpi: Map<number, string[]>; // NPI → facilityId(s)
  byState: Map<string, string[]>; // 2-char state → facilityId(s)
  byHospIdNumeric: Map<number, string[]>; // numeric CCN suffix → facilityId(s)
}

async function buildFacilityIndex(): Promise<FacilityIndex> {
  const appFacilities = await listLinkableFacilities();

  const byCcn = new Map<string, string[]>();
  const byNpi = new Map<number, string[]>();
  const byState = new Map<string, string[]>();
  const byHospIdNumeric = new Map<number, string[]>();
  for (const f of appFacilities) {
    if (f.cmsId) {
      const k = f.cmsId.trim();
      const arr = byCcn.get(k) ?? [];
      arr.push(f.id);
      byCcn.set(k, arr);
      const num = Number(k.replace(/\D/g, ""));
      if (Number.isFinite(num) && num > 0) {
        const arr2 = byHospIdNumeric.get(num) ?? [];
        arr2.push(f.id);
        byHospIdNumeric.set(num, arr2);
      }
    }
    if (f.npi && /^\d{10}$/.test(f.npi)) {
      const npi = Number(f.npi);
      const arr = byNpi.get(npi) ?? [];
      arr.push(f.id);
      byNpi.set(npi, arr);
    }
    if (f.state) {
      const arr = byState.get(f.state) ?? [];
      arr.push(f.id);
      byState.set(f.state, arr);
    }
  }

  // Resolve enrollment_ids from the CCN list against the warehouse.
  const byEnrollmentId = new Map<string, string[]>();
  const ccns = Array.from(byCcn.keys());
  if (ccns.length > 0) {
    const rows = await db
      .select({
        enrollmentId: medintelDimFacility.enrollmentId,
        ccn: medintelDimFacility.ccn,
      })
      .from(medintelDimFacility)
      .where(inArray(medintelDimFacility.ccn, ccns));
    for (const r of rows) {
      if (!r.ccn) continue;
      const facilityIds = byCcn.get(r.ccn) ?? [];
      const arr = byEnrollmentId.get(r.enrollmentId) ?? [];
      for (const fid of facilityIds) if (!arr.includes(fid)) arr.push(fid);
      byEnrollmentId.set(r.enrollmentId, arr);
    }
  }

  // Resolve enrollment_ids from the NPI list via the bridge.
  const npis = Array.from(byNpi.keys());
  if (npis.length > 0) {
    const rows = await db
      .select({
        enrollmentId: medintelBridgeNpiEnrollment.enrollmentId,
        npi: medintelBridgeNpiEnrollment.npi,
      })
      .from(medintelBridgeNpiEnrollment)
      .where(inArray(medintelBridgeNpiEnrollment.npi, npis));
    for (const r of rows) {
      const facilityIds = byNpi.get(r.npi) ?? [];
      const arr = byEnrollmentId.get(r.enrollmentId) ?? [];
      for (const fid of facilityIds) if (!arr.includes(fid)) arr.push(fid);
      byEnrollmentId.set(r.enrollmentId, arr);
    }
  }

  return { byEnrollmentId, byCcn, byNpi, byState, byHospIdNumeric };
}

/**
 * Insert a signal row only if (facility_id, signal_type, signal_value) is not
 * already present and active. signal_value carries the source identifier so
 * the same CHOW or owner doesn't double-emit on re-runs.
 */
async function insertIfNew(
  rows: Array<InsertSignal & { signalValue: string }>,
): Promise<number> {
  if (rows.length === 0) return 0;

  // Existing active rows keyed by (facility_id, signal_type, signal_value).
  const existing = await db
    .select({
      facilityId: purchaseSignals.facilityId,
      signalType: purchaseSignals.signalType,
      signalValue: purchaseSignals.signalValue,
    })
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.isActive, true),
        eq(purchaseSignals.source, SOURCE),
        inArray(
          purchaseSignals.facilityId,
          Array.from(new Set(rows.map((r) => r.facilityId))),
        ),
      ),
    );
  const seen = new Set(
    existing.map((e) => `${e.facilityId}|${e.signalType}|${e.signalValue ?? ""}`),
  );

  const fresh = rows.filter(
    (r) => !seen.has(`${r.facilityId}|${r.signalType}|${r.signalValue ?? ""}`),
  );
  if (fresh.length === 0) return 0;

  await db.insert(purchaseSignals).values(fresh);
  return fresh.length;
}

// ─── Rule: chow_recent ───────────────────────────────────────────────────────

async function emitChowRecent(idx: FacilityIndex): Promise<number> {
  const enrollmentIds = Array.from(idx.byEnrollmentId.keys());
  const ccns = Array.from(idx.byCcn.keys());
  if (enrollmentIds.length === 0 && ccns.length === 0) return 0;

  const since = new Date();
  since.setMonth(since.getMonth() - CHOW_LOOKBACK_MONTHS);
  const sinceStr = since.toISOString().slice(0, 10);

  const conds = [gte(medintelFactChow.effectiveDate, sinceStr)];
  const matchAny = [];
  if (enrollmentIds.length > 0) {
    matchAny.push(inArray(medintelFactChow.enrollmentIdBuyer, enrollmentIds));
  }
  if (ccns.length > 0) {
    matchAny.push(inArray(medintelFactChow.ccnBuyer, ccns));
  }
  if (matchAny.length === 0) return 0;

  const rows = await db
    .select()
    .from(medintelFactChow)
    .where(and(...conds, sql`(${sql.join(matchAny, sql` OR `)})`))
    .orderBy(medintelFactChow.effectiveDate);

  const inserts: Array<InsertSignal & { signalValue: string }> = [];
  for (const r of rows) {
    const fids = new Set<string>();
    if (r.enrollmentIdBuyer) {
      for (const fid of idx.byEnrollmentId.get(r.enrollmentIdBuyer) ?? []) fids.add(fid);
    }
    if (r.ccnBuyer) {
      for (const fid of idx.byCcn.get(r.ccnBuyer) ?? []) fids.add(fid);
    }
    for (const facilityId of fids) {
      inserts.push({
        facilityId,
        signalType: "chow_recent",
        signalValue: `chow:${r.chowPk}`,
        confidence: 90,
        source: SOURCE,
        metadata: {
          buyer: r.organizationNameBuyer,
          seller: r.organizationNameSeller,
          ccnBuyer: r.ccnBuyer,
          chowType: r.chowTypeText,
          effectiveDate: r.effectiveDate,
          vertical: r.vertical,
        },
      });
    }
  }
  return insertIfNew(inserts);
}

// ─── Rule: pe_takeover / reit_takeover / chain_acquisition ────────────────────

async function emitOwnershipRules(idx: FacilityIndex): Promise<{
  pe: number;
  reit: number;
  chain: number;
}> {
  const enrollmentIds = Array.from(idx.byEnrollmentId.keys());
  if (enrollmentIds.length === 0) return { pe: 0, reit: 0, chain: 0 };

  // Pull every PE/REIT/chain-flagged ownership row for the linked enrollments
  // in one go; group in memory.
  const ownerships = await db
    .select()
    .from(medintelFactOwnership)
    .where(
      and(
        inArray(medintelFactOwnership.enrollmentId, enrollmentIds),
        sql`(
          ${medintelFactOwnership.isPrivateEquity} = TRUE
          OR ${medintelFactOwnership.isReit} = TRUE
          OR ${medintelFactOwnership.isChainHomeOffice} = TRUE
        )`,
      ),
    );

  // Chain rule needs a count of facilities per owner — fetch all enrollments
  // for the implicated owners and bucket.
  const chainOwnerIds = Array.from(
    new Set(
      ownerships
        .filter((o) => o.isChainHomeOffice)
        .map((o) => o.associateIdOwner),
    ),
  );
  const chainFacilityCounts = new Map<number, number>();
  if (chainOwnerIds.length > 0) {
    const counts = await db
      .select({
        associateIdOwner: medintelFactOwnership.associateIdOwner,
        count: sql<number>`COUNT(DISTINCT ${medintelFactOwnership.enrollmentId})::int`,
      })
      .from(medintelFactOwnership)
      .where(inArray(medintelFactOwnership.associateIdOwner, chainOwnerIds))
      .groupBy(medintelFactOwnership.associateIdOwner);
    for (const c of counts) chainFacilityCounts.set(c.associateIdOwner, c.count);
  }

  // Owner names for metadata
  const ownerIds = Array.from(new Set(ownerships.map((o) => o.associateIdOwner)));
  const owners = ownerIds.length > 0
    ? await db
        .select()
        .from(medintelDimOwner)
        .where(inArray(medintelDimOwner.associateIdOwner, ownerIds))
    : [];
  const ownerName = new Map<number, string>();
  for (const o of owners) {
    ownerName.set(
      o.associateIdOwner,
      o.organizationName ?? [o.firstName, o.lastName].filter(Boolean).join(" ") ?? "Unknown",
    );
  }

  const peInserts: Array<InsertSignal & { signalValue: string }> = [];
  const reitInserts: Array<InsertSignal & { signalValue: string }> = [];
  const chainInserts: Array<InsertSignal & { signalValue: string }> = [];

  for (const o of ownerships) {
    const facilityIds = idx.byEnrollmentId.get(o.enrollmentId) ?? [];
    if (facilityIds.length === 0) continue;

    if (o.isPrivateEquity) {
      for (const facilityId of facilityIds) {
        peInserts.push({
          facilityId,
          signalType: "pe_takeover",
          signalValue: `pe:${o.associateIdOwner}`,
          confidence: 85,
          source: SOURCE,
          metadata: {
            ownerName: ownerName.get(o.associateIdOwner),
            associateIdOwner: o.associateIdOwner,
            percentageOwnership: o.percentageOwnership,
            associationDate: o.associationDate,
            roleText: o.roleText,
          },
        });
      }
    }
    if (o.isReit) {
      for (const facilityId of facilityIds) {
        reitInserts.push({
          facilityId,
          signalType: "reit_takeover",
          signalValue: `reit:${o.associateIdOwner}`,
          confidence: 85,
          source: SOURCE,
          metadata: {
            ownerName: ownerName.get(o.associateIdOwner),
            associateIdOwner: o.associateIdOwner,
            percentageOwnership: o.percentageOwnership,
          },
        });
      }
    }
    if (o.isChainHomeOffice) {
      const count = chainFacilityCounts.get(o.associateIdOwner) ?? 0;
      if (count >= 5) {
        for (const facilityId of facilityIds) {
          chainInserts.push({
            facilityId,
            signalType: "chain_acquisition",
            signalValue: `chain:${o.associateIdOwner}`,
            confidence: 80,
            source: SOURCE,
            metadata: {
              chainName: ownerName.get(o.associateIdOwner),
              facilitiesOwned: count,
              associateIdOwner: o.associateIdOwner,
            },
          });
        }
      }
    }
  }

  const [pe, reit, chain] = await Promise.all([
    insertIfNew(peInserts),
    insertIfNew(reitInserts),
    insertIfNew(chainInserts),
  ]);
  return { pe, reit, chain };
}

// ─── Rule: aip_infra_spend ───────────────────────────────────────────────────

const INFRA_CATEGORY_KEYWORDS = [
  "infrastructure",
  "infra",
  "health information technology",
  "hit",
  "health it",
  "facility",
  "capital",
  "equipment",
  "technology",
];

async function emitAipInfraSpend(idx: FacilityIndex): Promise<number> {
  const npis = Array.from(idx.byNpi.keys());
  if (npis.length === 0) return 0;

  // Find ACOs this facility may participate in via ASM roster name match.
  const asmRows = await db
    .select()
    .from(medintelFactAsmParticipant)
    .where(inArray(medintelFactAsmParticipant.npi, npis));

  const orgs = Array.from(
    new Set(asmRows.map((r) => r.organizationLegalName).filter((v): v is string => Boolean(v))),
  );
  if (orgs.length === 0) return 0;

  const acos = await db
    .select()
    .from(medintelDimAco)
    .where(
      sql`LOWER(${medintelDimAco.acoName}) IN (${sql.join(
        orgs.map((n) => sql`${n.toLowerCase()}`),
        sql`, `,
      )})`,
    );
  if (acos.length === 0) return 0;

  // ACO name → which app-facility-ids it should ping
  const acoIdToFacilityIds = new Map<string, Set<string>>();
  const acoNameById = new Map<string, string>();
  for (const a of acos) {
    acoNameById.set(a.acoId, (a.acoName ?? "").toLowerCase());
  }
  for (const r of asmRows) {
    const matchingAco = acos.find(
      (a) => (a.acoName ?? "").toLowerCase() === (r.organizationLegalName ?? "").toLowerCase(),
    );
    if (!matchingAco) continue;
    const fids = idx.byNpi.get(r.npi) ?? [];
    const set = acoIdToFacilityIds.get(matchingAco.acoId) ?? new Set();
    for (const fid of fids) set.add(fid);
    acoIdToFacilityIds.set(matchingAco.acoId, set);
  }

  const aip = await db
    .select()
    .from(medintelFactAipSpending)
    .where(
      inArray(
        medintelFactAipSpending.acoId,
        acos.map((a) => a.acoId),
      ),
    );

  const inserts: Array<InsertSignal & { signalValue: string }> = [];
  for (const row of aip) {
    const cat = `${row.generalSpendCategory ?? ""} ${row.generalSpendSubcategory ?? ""} ${row.paymentUse ?? ""}`.toLowerCase();
    if (!INFRA_CATEGORY_KEYWORDS.some((k) => cat.includes(k))) continue;
    const fids = acoIdToFacilityIds.get(row.acoId);
    if (!fids || fids.size === 0) continue;

    const projected =
      Number(row.projectedSpending2026 ?? 0) +
      Number(row.projectedSpending2025 ?? 0) +
      Number(row.projectedSpending2024 ?? 0);
    const actual =
      Number(row.actualSpending2026 ?? 0) +
      Number(row.actualSpending2025 ?? 0) +
      Number(row.actualSpending2024 ?? 0);

    for (const facilityId of fids) {
      inserts.push({
        facilityId,
        signalType: "aip_infra_spend",
        signalValue: `aip:${row.aipPk}`,
        confidence: 70,
        source: SOURCE,
        metadata: {
          acoId: row.acoId,
          paymentUse: row.paymentUse,
          generalSpendCategory: row.generalSpendCategory,
          generalSpendSubcategory: row.generalSpendSubcategory,
          totalProjected: projected || null,
          totalActual: actual || null,
        },
      });
    }
  }
  return insertIfNew(inserts);
}

// ─── Rule: cmmi_state_launch ─────────────────────────────────────────────────

async function emitCmmiStateLaunch(idx: FacilityIndex): Promise<number> {
  const states = Array.from(idx.byState.keys());
  if (states.length === 0) return 0;

  // Pull CMMI models that mention any of these states.
  const models = await db
    .select()
    .from(medintelDimCmmiModel)
    .where(
      and(
        isNotNull(medintelDimCmmiModel.states),
        sql`${medintelDimCmmiModel.states} && ${states}::text[]`,
        eq(medintelDimCmmiModel.displayModelSummary, true),
      ),
    );

  const inserts: Array<InsertSignal & { signalValue: string }> = [];
  for (const m of models) {
    for (const state of m.states ?? []) {
      const fids = idx.byState.get(state) ?? [];
      for (const facilityId of fids) {
        inserts.push({
          facilityId,
          signalType: "cmmi_state_launch",
          signalValue: `cmmi:${m.uniqueId}`,
          confidence: 60,
          source: SOURCE,
          metadata: {
            modelName: m.modelName,
            category: m.category,
            authority: m.authority,
            stage: m.stage,
            dateBegan: m.dateBegan,
            url: m.url,
            state,
          },
        });
      }
    }
  }
  return insertIfNew(inserts);
}

// ─── Rule: psi11_outlier ─────────────────────────────────────────────────────

async function emitPsi11Outlier(idx: FacilityIndex): Promise<number> {
  const hospIds = Array.from(idx.byHospIdNumeric.keys());
  if (hospIds.length === 0) return 0;

  // National-average rate for the most recent reporting period.
  const [avgRow] = await db
    .select({ avgRate: sql<number>`AVG(${medintelFactPsi11.rate})::float` })
    .from(medintelFactPsi11);
  const nationalAvg = avgRow?.avgRate;
  if (nationalAvg == null) return 0;

  const rows = await db
    .select()
    .from(medintelFactPsi11)
    .where(
      and(
        inArray(medintelFactPsi11.hospId, hospIds),
        sql`${medintelFactPsi11.rate} > ${nationalAvg}`,
      ),
    );

  const inserts: Array<InsertSignal & { signalValue: string }> = [];
  for (const r of rows) {
    const fids = idx.byHospIdNumeric.get(r.hospId) ?? [];
    for (const facilityId of fids) {
      inserts.push({
        facilityId,
        signalType: "psi11_outlier",
        signalValue: `psi11:${r.hospId}:${r.startQuarter}`,
        confidence: 65,
        source: SOURCE,
        metadata: {
          rate: r.rate,
          nationalAvg,
          startQuarter: r.startQuarter,
          endQuarter: r.endQuarter,
          intervalLowerLimit: r.intervalLowerLimit,
          intervalHigherLimit: r.intervalHigherLimit,
        },
      });
    }
  }
  return insertIfNew(inserts);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface MedintelScanResult {
  facilitiesScanned: number;
  enrollmentsMatched: number;
  signalsInserted: number;
  byRule: Record<string, number>;
  errors: number;
}

export async function scanMedintelSignals(): Promise<MedintelScanResult> {
  const start = Date.now();
  let errors = 0;
  const byRule: Record<string, number> = {};

  let idx: FacilityIndex;
  try {
    idx = await buildFacilityIndex();
  } catch (err) {
    logger.error({ err }, "medintel scorer: failed to build facility index");
    return {
      facilitiesScanned: 0,
      enrollmentsMatched: 0,
      signalsInserted: 0,
      byRule: {},
      errors: 1,
    };
  }

  const facilitiesScanned =
    idx.byCcn.size + idx.byNpi.size; // upper bound; the union is smaller
  const enrollmentsMatched = idx.byEnrollmentId.size;

  async function run(rule: string, fn: () => Promise<number>): Promise<void> {
    try {
      byRule[rule] = await fn();
    } catch (err) {
      logger.error({ err, rule }, "medintel scorer rule failed");
      byRule[rule] = 0;
      errors++;
    }
  }

  await run("chow_recent", () => emitChowRecent(idx));

  try {
    const { pe, reit, chain } = await emitOwnershipRules(idx);
    byRule["pe_takeover"] = pe;
    byRule["reit_takeover"] = reit;
    byRule["chain_acquisition"] = chain;
  } catch (err) {
    logger.error({ err, rule: "ownership" }, "medintel scorer rule failed");
    byRule["pe_takeover"] = 0;
    byRule["reit_takeover"] = 0;
    byRule["chain_acquisition"] = 0;
    errors++;
  }

  await run("aip_infra_spend", () => emitAipInfraSpend(idx));
  await run("cmmi_state_launch", () => emitCmmiStateLaunch(idx));
  await run("psi11_outlier", () => emitPsi11Outlier(idx));

  const signalsInserted = Object.values(byRule).reduce((a, b) => a + b, 0);

  logger.info(
    {
      facilitiesScanned,
      enrollmentsMatched,
      signalsInserted,
      byRule,
      errors,
      ms: Date.now() - start,
    },
    "medintel scorer complete",
  );

  return { facilitiesScanned, enrollmentsMatched, signalsInserted, byRule, errors };
}

// Re-export for tests / ad-hoc invocation if needed.
void facilities;
