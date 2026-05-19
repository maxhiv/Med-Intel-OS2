/**
 * TanStack Query hook for the medintel intelligence endpoint.
 *
 * The endpoint isn't in the OpenAPI spec yet (that's the follow-up codegen
 * pass), so this hook talks to the API directly via the same fetch wrapper
 * the generated client uses. When the spec is updated the hook can be
 * replaced by `useGetFacilityIntelligence` from `@workspace/api-client-react`.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

export interface MedintelOwnershipFlags {
  anyPrivateEquity: boolean;
  anyReit: boolean;
  anyHoldingCompany: boolean;
  anyChainHomeOffice: boolean;
  anyMgmtServices: boolean;
  forProfit: boolean | null;
}

export interface MedintelOwner {
  associateIdOwner: number;
  ownerType: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  title: string | null;
  organizationName: string | null;
  doingBusinessAsName: string | null;
  city: string | null;
  state: string | null;
  isCorporation: boolean | null;
  isLlc: boolean | null;
  isHoldingCompany: boolean | null;
  isPrivateEquity: boolean | null;
  isReit: boolean | null;
  isChainHomeOffice: boolean | null;
  isMgmtServices: boolean | null;
  isForProfit: boolean | null;
  isNonProfit: boolean | null;
}

export interface MedintelOwnershipRow {
  enrollmentId: string;
  associateIdOwner: number;
  roleCode: number;
  roleText: string | null;
  ownerType: string | null;
  associationDate: string | null;
  percentageOwnership: string | null;
  isPrivateEquity: boolean | null;
  isReit: boolean | null;
  isHoldingCompany: boolean | null;
  isChainHomeOffice: boolean | null;
}

export interface MedintelOwnershipEntry {
  ownership: MedintelOwnershipRow;
  owner: MedintelOwner | null;
}

export interface MedintelChowEvent {
  chowPk: number;
  enrollmentIdBuyer: string | null;
  ccnBuyer: string | null;
  organizationNameBuyer: string | null;
  enrollmentIdSeller: string | null;
  ccnSeller: string | null;
  organizationNameSeller: string | null;
  chowTypeCode: string | null;
  chowTypeText: string | null;
  effectiveDate: string | null;
  vertical: string | null;
}

export interface MedintelCostReport {
  rptRecNum: number;
  providerCcn: string | null;
  hospitalName: string | null;
  fiscalYearBeginDate: string | null;
  fiscalYearEndDate: string | null;
  numberOfBeds: string | null;
  totalDaysAll: string | null;
  totalDischargesAll: string | null;
  totalCosts: string | null;
  totalAssets: string | null;
  totalCurrentAssets: string | null;
  cashOnHandInBanks: string | null;
  investments: string | null;
  costOfCharityCare: string | null;
  costOfUncompensatedCare: string | null;
  depreciationCost: string | null;
  netIncome: string | null;
  netPatientRevenue: string | null;
  totalPatientRevenue: string | null;
  inpatientRevenue: string | null;
  outpatientRevenue: string | null;
}

export interface MedintelServiceAreaRow {
  ccn: string;
  zipCode: string;
  calendarYear: number;
  totalDischarges: string | null;
  totalDays: string | null;
  totalCharges: string | null;
}

export interface MedintelPsi11Row {
  hospId: number;
  rate: string | null;
  intervalLowerLimit: string | null;
  intervalHigherLimit: string | null;
  startQuarter: string;
  endQuarter: string | null;
}

export interface MedintelAcoEntry {
  aco: {
    acoId: string;
    acoName: string | null;
    agreeType: string | null;
    currentTrack: string | null;
    riskModel: string | null;
  };
  performance: {
    performanceYear: number;
    nAb: number | null;
    savRate: string | null;
    qualScore: string | null;
    aipFlag: boolean | null;
    aipBalance: string | null;
  } | null;
  aipSpending: Array<{
    aipPk: number;
    paymentUse: string | null;
    generalSpendCategory: string | null;
    generalSpendSubcategory: string | null;
    totalAipReceivedThruDec2025: string | null;
    projectedSpending2024: string | null;
    actualSpending2024: string | null;
    projectedSpending2025: string | null;
    actualSpending2025: string | null;
    projectedSpending2026: string | null;
    actualSpending2026: string | null;
  }>;
}

export interface MedintelCmmiModel {
  uniqueId: number;
  modelName: string | null;
  stage: string | null;
  category: string | null;
  authority: string | null;
  description: string | null;
  dateBegan: number | null;
  dateEnded: number | null;
  states: string[] | null;
  keywords: string[] | null;
  url: string | null;
}

export interface MedintelIdentity {
  enrollmentId: string;
  vertical: string | null;
  ccn: string | null;
  ccnAcronym: string | null;
  primaryNpi: number | null;
  organizationName: string | null;
  doingBusinessAsName: string | null;
  state: string | null;
  city: string | null;
  zipCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  telephoneNumber: string | null;
  incorporationDate: string | null;
  proprietaryNonprofit: string | null;
  sourceAsOfDate: string | null;
}

export interface MedintelAddress {
  isPrimary: boolean;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  telephoneNumber: string | null;
  sourceFile: string | null;
}

export interface MedintelNpi {
  npi: number;
  isPrimary: boolean;
  sourceFile: string | null;
}

export interface MedintelChainSummary {
  chainName: string;
  facilitiesOwned: number;
  statesPresent: string[];
  verticals: string[];
}

export interface MedintelAsmRow {
  npi: number;
  asmCohort: string;
  organizationLegalName: string | null;
  asmCy27Participant: boolean | null;
  asmCy28Participant: boolean | null;
  asmCy29Participant: boolean | null;
}

export interface FacilityIntelligenceResponse {
  matched: boolean;
  enrollmentIds: string[];
  identity: MedintelIdentity | null;
  addresses: MedintelAddress[];
  npis: MedintelNpi[];
  owners: MedintelOwnershipEntry[];
  ownershipFlags: MedintelOwnershipFlags;
  recentChow: MedintelChowEvent | null;
  chowHistory: MedintelChowEvent[];
  costReport: MedintelCostReport | null;
  costReportHistory: MedintelCostReport[];
  serviceArea: MedintelServiceAreaRow[];
  psi11: MedintelPsi11Row[];
  acoParticipation: MedintelAcoEntry[];
  asmParticipation: MedintelAsmRow[];
  cmmiModelsInState: MedintelCmmiModel[];
  chainSummary: MedintelChainSummary | null;
}

export function useGetFacilityIntelligence(
  facilityId: string | undefined,
  options?: Omit<
    UseQueryOptions<FacilityIntelligenceResponse, Error>,
    "queryKey" | "queryFn" | "enabled"
  > & { enabled?: boolean },
) {
  return useQuery<FacilityIntelligenceResponse, Error>({
    queryKey: ["facility-intelligence", facilityId],
    enabled: Boolean(facilityId) && (options?.enabled ?? true),
    queryFn: () =>
      customFetch<FacilityIntelligenceResponse>(
        `/api/facilities/${facilityId}/intelligence`,
        { method: "GET", responseType: "json" },
      ),
    staleTime: 5 * 60_000,
    ...options,
  });
}
