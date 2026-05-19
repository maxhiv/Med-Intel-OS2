/**
 * Read-only assembler for the `medintel.*` warehouse.
 *
 * Given an app-side `facilities` row (CCN and/or NPI), this resolves the
 * matching PECOS enrollment and returns a single JSON blob with everything
 * the hospital card needs: identity, ownership tree, CHOW history, HCRIS
 * financials, service area, PSI-11, ACO/ASM/CMMI participation.
 *
 * Match strategy (in order):
 *   1. Exact CCN match against `medintel.dim_facility.ccn`.
 *   2. NPI bridge — `medintel.bridge_npi_enrollment` keyed by `facilities.npi`.
 *
 * All warehouse tables live in the `medintel` schema with no `account_id`,
 * so this module deliberately does NOT scope queries by tenant. Tenant
 * isolation is enforced upstream — callers verify the requesting account
 * owns the app-side facility before invoking us.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  facilities,
  type Facility,
  medintelDimFacility,
  medintelDimOwner,
  medintelFactOwnership,
  medintelFactChow,
  medintelFactCostReport,
  medintelFactServiceArea,
  medintelFactPsi11,
  medintelDimAco,
  medintelFactAcoPerformance,
  medintelFactAipSpending,
  medintelFactAsmParticipant,
  medintelDimCmmiModel,
  medintelBridgeNpiEnrollment,
  medintelBridgeFacilityAddress,
  type MedintelDimFacility,
  type MedintelDimOwner,
  type MedintelFactOwnership,
  type MedintelFactChow,
  type MedintelFactCostReport,
  type MedintelFactServiceArea,
  type MedintelFactPsi11,
  type MedintelDimAco,
  type MedintelFactAcoPerformance,
  type MedintelFactAipSpending,
  type MedintelFactAsmParticipant,
  type MedintelDimCmmiModel,
  type MedintelBridgeNpiEnrollment,
  type MedintelBridgeFacilityAddress,
} from "@workspace/db";

/** All NPI-bearing rows we'll cross-reference for an enrollment. */
async function npisForEnrollment(enrollmentId: string): Promise<number[]> {
  const rows = await db
    .select({ npi: medintelBridgeNpiEnrollment.npi })
    .from(medintelBridgeNpiEnrollment)
    .where(eq(medintelBridgeNpiEnrollment.enrollmentId, enrollmentId));
  return rows.map((r) => r.npi).filter((n): n is number => n != null);
}

/**
 * Resolve an app-side `facilities` row to a medintel `enrollment_id`. The
 * warehouse may carry multiple enrollments per real facility (PECOS records
 * Hospital + FQHC + RHC separately for vertically-integrated systems); we
 * return all matches so the API can fan out if needed.
 */
export async function findEnrollmentIdsForFacility(
  facility: Pick<Facility, "id" | "cmsId" | "npi">,
): Promise<string[]> {
  const ids = new Set<string>();

  // 1) CCN match (most reliable when the app row has a real CCN).
  if (facility.cmsId && facility.cmsId.trim() !== "") {
    const ccnRows = await db
      .select({ enrollmentId: medintelDimFacility.enrollmentId })
      .from(medintelDimFacility)
      .where(eq(medintelDimFacility.ccn, facility.cmsId.trim()));
    for (const r of ccnRows) ids.add(r.enrollmentId);
  }

  // 2) NPI bridge — handles enrollments missing a CCN and additional NPIs.
  if (facility.npi && /^\d{10}$/.test(facility.npi)) {
    const npi = Number(facility.npi);
    const npiRows = await db
      .select({ enrollmentId: medintelBridgeNpiEnrollment.enrollmentId })
      .from(medintelBridgeNpiEnrollment)
      .where(eq(medintelBridgeNpiEnrollment.npi, npi));
    for (const r of npiRows) ids.add(r.enrollmentId);
  }

  return Array.from(ids);
}

// ─── Result shape ────────────────────────────────────────────────────────────

export interface OwnershipEntry {
  ownership: MedintelFactOwnership;
  owner: MedintelDimOwner | null;
}

export interface FacilityIntelligence {
  matched: boolean;
  enrollmentIds: string[];
  identity: MedintelDimFacility | null;
  addresses: MedintelBridgeFacilityAddress[];
  npis: MedintelBridgeNpiEnrollment[];
  owners: OwnershipEntry[];
  ownershipFlags: {
    anyPrivateEquity: boolean;
    anyReit: boolean;
    anyHoldingCompany: boolean;
    anyChainHomeOffice: boolean;
    anyMgmtServices: boolean;
    forProfit: boolean | null;
  };
  recentChow: MedintelFactChow | null;
  chowHistory: MedintelFactChow[];
  costReport: MedintelFactCostReport | null;
  costReportHistory: MedintelFactCostReport[];
  serviceArea: MedintelFactServiceArea[];
  psi11: MedintelFactPsi11[];
  acoParticipation: Array<{
    aco: MedintelDimAco;
    performance: MedintelFactAcoPerformance | null;
    aipSpending: MedintelFactAipSpending[];
  }>;
  asmParticipation: MedintelFactAsmParticipant[];
  cmmiModelsInState: MedintelDimCmmiModel[];
  chainSummary: {
    chainName: string;
    facilitiesOwned: number;
    statesPresent: string[];
    verticals: string[];
  } | null;
}

const EMPTY: FacilityIntelligence = {
  matched: false,
  enrollmentIds: [],
  identity: null,
  addresses: [],
  npis: [],
  owners: [],
  ownershipFlags: {
    anyPrivateEquity: false,
    anyReit: false,
    anyHoldingCompany: false,
    anyChainHomeOffice: false,
    anyMgmtServices: false,
    forProfit: null,
  },
  recentChow: null,
  chowHistory: [],
  costReport: null,
  costReportHistory: [],
  serviceArea: [],
  psi11: [],
  acoParticipation: [],
  asmParticipation: [],
  cmmiModelsInState: [],
  chainSummary: null,
};

// ─── Assemblers ──────────────────────────────────────────────────────────────

async function loadOwners(enrollmentIds: string[]): Promise<OwnershipEntry[]> {
  if (enrollmentIds.length === 0) return [];

  const ownerships = await db
    .select()
    .from(medintelFactOwnership)
    .where(inArray(medintelFactOwnership.enrollmentId, enrollmentIds))
    .orderBy(
      desc(medintelFactOwnership.percentageOwnership),
      desc(medintelFactOwnership.associationDate),
    );

  const ownerIds = Array.from(
    new Set(ownerships.map((o) => o.associateIdOwner).filter((v): v is number => v != null)),
  );

  const ownersById = new Map<number, MedintelDimOwner>();
  if (ownerIds.length > 0) {
    const owners = await db
      .select()
      .from(medintelDimOwner)
      .where(inArray(medintelDimOwner.associateIdOwner, ownerIds));
    for (const o of owners) ownersById.set(o.associateIdOwner, o);
  }

  return ownerships.map((o) => ({
    ownership: o,
    owner: ownersById.get(o.associateIdOwner) ?? null,
  }));
}

async function loadChow(
  enrollmentIds: string[],
  ccns: string[],
): Promise<{ recent: MedintelFactChow | null; history: MedintelFactChow[] }> {
  if (enrollmentIds.length === 0 && ccns.length === 0) {
    return { recent: null, history: [] };
  }
  const conds = [];
  if (enrollmentIds.length > 0) {
    conds.push(inArray(medintelFactChow.enrollmentIdBuyer, enrollmentIds));
    conds.push(inArray(medintelFactChow.enrollmentIdSeller, enrollmentIds));
  }
  if (ccns.length > 0) {
    conds.push(inArray(medintelFactChow.ccnBuyer, ccns));
    conds.push(inArray(medintelFactChow.ccnSeller, ccns));
  }
  const history = await db
    .select()
    .from(medintelFactChow)
    .where(or(...conds))
    .orderBy(desc(medintelFactChow.effectiveDate))
    .limit(50);
  return { recent: history[0] ?? null, history };
}

async function loadCostReport(
  ccns: string[],
): Promise<{ current: MedintelFactCostReport | null; history: MedintelFactCostReport[] }> {
  if (ccns.length === 0) return { current: null, history: [] };
  const rows = await db
    .select()
    .from(medintelFactCostReport)
    .where(inArray(medintelFactCostReport.providerCcn, ccns))
    .orderBy(desc(medintelFactCostReport.fiscalYearEndDate))
    .limit(10);
  return { current: rows[0] ?? null, history: rows };
}

async function loadServiceArea(ccns: string[]): Promise<MedintelFactServiceArea[]> {
  if (ccns.length === 0) return [];
  return await db
    .select()
    .from(medintelFactServiceArea)
    .where(inArray(medintelFactServiceArea.ccn, ccns))
    .orderBy(desc(medintelFactServiceArea.totalCharges))
    .limit(50);
}

async function loadPsi11(ccns: string[]): Promise<MedintelFactPsi11[]> {
  // PSI-11 keys on hosp_id (an HCUP-assigned numeric id, NOT a CCN). The
  // current data drop ships the file orphaned of a CCN crosswalk — so until
  // that lookup is loaded, we degrade gracefully to "no rows".
  if (ccns.length === 0) return [];
  // Best-effort numeric CCN match — many cost reports record the hosp_id
  // directly in the numeric portion of the CCN; this lights up rows when the
  // alignment happens to match, and stays empty when it doesn't.
  const numericIds = ccns
    .map((c) => Number(c.replace(/\D/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) return [];
  return await db
    .select()
    .from(medintelFactPsi11)
    .where(inArray(medintelFactPsi11.hospId, numericIds))
    .orderBy(desc(medintelFactPsi11.startDate))
    .limit(20);
}

async function loadAcoParticipation(
  npis: number[],
): Promise<FacilityIntelligence["acoParticipation"]> {
  if (npis.length === 0) return [];

  // No direct facility ↔ ACO link in PECOS; instead we surface ACOs whose
  // ASM participant list (CY27 cohort) includes any of this facility's NPIs.
  const asmRows = await db
    .select()
    .from(medintelFactAsmParticipant)
    .where(inArray(medintelFactAsmParticipant.npi, npis));
  const acoNamesFromAsm = new Set(
    asmRows.map((r) => r.organizationLegalName).filter((v): v is string => Boolean(v)),
  );
  if (acoNamesFromAsm.size === 0) return [];

  // Match ACO by name (best-effort case-insensitive).
  const acos = await db
    .select()
    .from(medintelDimAco)
    .where(
      sql`LOWER(${medintelDimAco.acoName}) IN (${sql.join(
        Array.from(acoNamesFromAsm).map((n) => sql`${n.toLowerCase()}`),
        sql`, `,
      )})`,
    );
  if (acos.length === 0) return [];

  const acoIds = acos.map((a) => a.acoId);
  const [perf, aip] = await Promise.all([
    db
      .select()
      .from(medintelFactAcoPerformance)
      .where(inArray(medintelFactAcoPerformance.acoId, acoIds))
      .orderBy(desc(medintelFactAcoPerformance.performanceYear)),
    db
      .select()
      .from(medintelFactAipSpending)
      .where(inArray(medintelFactAipSpending.acoId, acoIds)),
  ]);

  const perfByAco = new Map<string, MedintelFactAcoPerformance>();
  for (const p of perf) if (!perfByAco.has(p.acoId)) perfByAco.set(p.acoId, p);

  const aipByAco = new Map<string, MedintelFactAipSpending[]>();
  for (const r of aip) {
    const arr = aipByAco.get(r.acoId) ?? [];
    arr.push(r);
    aipByAco.set(r.acoId, arr);
  }

  return acos.map((a) => ({
    aco: a,
    performance: perfByAco.get(a.acoId) ?? null,
    aipSpending: aipByAco.get(a.acoId) ?? [],
  }));
}

async function loadAsmRows(npis: number[]): Promise<MedintelFactAsmParticipant[]> {
  if (npis.length === 0) return [];
  return await db
    .select()
    .from(medintelFactAsmParticipant)
    .where(inArray(medintelFactAsmParticipant.npi, npis));
}

async function loadCmmiForState(state: string | null): Promise<MedintelDimCmmiModel[]> {
  if (!state) return [];
  // states is a TEXT[] in the warehouse; use `= ANY(...)` for index-friendly match.
  return await db
    .select()
    .from(medintelDimCmmiModel)
    .where(sql`${state} = ANY(${medintelDimCmmiModel.states})`)
    .limit(50);
}

async function loadChainSummary(
  ownerEntries: OwnershipEntry[],
): Promise<FacilityIntelligence["chainSummary"]> {
  const chainOwner = ownerEntries.find(
    (e) =>
      e.owner?.isChainHomeOffice ||
      e.owner?.isHoldingCompany ||
      e.owner?.isPrivateEquity ||
      e.owner?.isReit,
  );
  if (!chainOwner?.owner) return null;

  const aId = chainOwner.owner.associateIdOwner;
  const enrollments = await db
    .select({ enrollmentId: medintelFactOwnership.enrollmentId })
    .from(medintelFactOwnership)
    .where(eq(medintelFactOwnership.associateIdOwner, aId));
  const enrollmentIds = enrollments.map((e) => e.enrollmentId);
  if (enrollmentIds.length === 0) return null;

  const facs = await db
    .select({
      state: medintelDimFacility.state,
      vertical: medintelDimFacility.vertical,
    })
    .from(medintelDimFacility)
    .where(inArray(medintelDimFacility.enrollmentId, enrollmentIds));

  const states = Array.from(
    new Set(facs.map((f) => f.state).filter((s): s is string => Boolean(s))),
  ).sort();
  const verticals = Array.from(
    new Set(facs.map((f) => f.vertical).filter((v): v is string => Boolean(v))),
  ).sort();

  return {
    chainName:
      chainOwner.owner.organizationName ??
      [chainOwner.owner.firstName, chainOwner.owner.lastName]
        .filter(Boolean)
        .join(" ") ??
      "Unknown chain",
    facilitiesOwned: facs.length,
    statesPresent: states,
    verticals,
  };
}

/**
 * Main entry point. Returns assembled intelligence for an app-side facility,
 * or a zeroed-out result with `matched: false` if no warehouse match exists.
 */
export async function getFacilityIntelligence(
  facility: Pick<Facility, "id" | "cmsId" | "npi" | "state">,
): Promise<FacilityIntelligence> {
  const enrollmentIds = await findEnrollmentIdsForFacility(facility);
  if (enrollmentIds.length === 0) {
    // Still try CMMI/state in case the app row has a state but no warehouse match.
    const cmmiOnly = await loadCmmiForState(facility.state ?? null);
    return { ...EMPTY, cmmiModelsInState: cmmiOnly };
  }

  // Identity = first matched enrollment (most relevant when there are many).
  const facilities2 = await db
    .select()
    .from(medintelDimFacility)
    .where(inArray(medintelDimFacility.enrollmentId, enrollmentIds));
  const identity = facilities2[0] ?? null;
  const ccns = Array.from(
    new Set(
      facilities2
        .map((f) => f.ccn)
        .filter((c): c is string => Boolean(c)),
    ),
  );

  const [addresses, npiRows] = await Promise.all([
    db
      .select()
      .from(medintelBridgeFacilityAddress)
      .where(inArray(medintelBridgeFacilityAddress.enrollmentId, enrollmentIds))
      .orderBy(desc(medintelBridgeFacilityAddress.isPrimary)),
    db
      .select()
      .from(medintelBridgeNpiEnrollment)
      .where(inArray(medintelBridgeNpiEnrollment.enrollmentId, enrollmentIds))
      .orderBy(desc(medintelBridgeNpiEnrollment.isPrimary)),
  ]);

  const npiNumbers = Array.from(new Set(npiRows.map((r) => r.npi)));
  const owners = await loadOwners(enrollmentIds);

  const [
    { recent: recentChow, history: chowHistory },
    { current: costReport, history: costReportHistory },
    serviceArea,
    psi11,
    acoParticipation,
    asmParticipation,
    cmmiModelsInState,
    chainSummary,
  ] = await Promise.all([
    loadChow(enrollmentIds, ccns),
    loadCostReport(ccns),
    loadServiceArea(ccns),
    loadPsi11(ccns),
    loadAcoParticipation(npiNumbers),
    loadAsmRows(npiNumbers),
    loadCmmiForState(identity?.state ?? facility.state ?? null),
    loadChainSummary(owners),
  ]);

  const ownershipFlags = {
    anyPrivateEquity: owners.some((o) => o.ownership.isPrivateEquity ?? false),
    anyReit: owners.some((o) => o.ownership.isReit ?? false),
    anyHoldingCompany: owners.some((o) => o.ownership.isHoldingCompany ?? false),
    anyChainHomeOffice: owners.some((o) => o.ownership.isChainHomeOffice ?? false),
    anyMgmtServices: owners.some((o) => o.ownership.isMgmtServices ?? false),
    forProfit:
      owners.some((o) => o.ownership.isForProfit === true)
        ? true
        : owners.some((o) => o.ownership.isNonProfit === true)
          ? false
          : null,
  };

  return {
    matched: true,
    enrollmentIds,
    identity,
    addresses,
    npis: npiRows,
    owners,
    ownershipFlags,
    recentChow,
    chowHistory,
    costReport,
    costReportHistory,
    serviceArea,
    psi11,
    acoParticipation,
    asmParticipation,
    cmmiModelsInState,
    chainSummary,
  };
}

/**
 * Light cross-walk used by the signal scorer — iterate every facility that
 * has either a CCN or a 10-digit NPI we can join against the warehouse.
 */
export async function listLinkableFacilities(): Promise<
  Array<Pick<Facility, "id" | "cmsId" | "npi" | "state">>
> {
  return await db
    .select({
      id: facilities.id,
      cmsId: facilities.cmsId,
      npi: facilities.npi,
      state: facilities.state,
    })
    .from(facilities)
    .where(
      or(
        sql`${facilities.cmsId} IS NOT NULL AND ${facilities.cmsId} <> ''`,
        sql`${facilities.npi} ~ '^[0-9]{10}$'`,
      ),
    );
}

// Silence the unused-import linter for helpers kept for follow-up rules.
void npisForEnrollment;
void gte;
void and;
void isNull;
