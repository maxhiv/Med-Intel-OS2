/**
 * Territory & equipment-line API hooks. Manual wrappers around customFetch
 * (these endpoints aren't in the OpenAPI spec yet — that's a follow-up).
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ViewKind = "buy_side" | "sell_side";

export interface OwnershipFilter {
  privateEquity?: boolean;
  reit?: boolean;
  chain?: boolean;
  holdingCompany?: boolean;
  forProfit?: boolean | "either";
}

export interface FinancialSizeFilter {
  minBeds?: number;
  minTotalAssets?: number;
  minNetPatientRevenue?: number;
}

export interface CycleFilter {
  recentChow?: boolean;
  aipInfraSpend?: boolean;
  cmmiStateLaunch?: boolean;
  psi11Outlier?: boolean;
}

export interface ServiceMixFilter {
  minOutpatientRevenue?: number;
  minInpatientRevenue?: number;
  minDischarges?: number;
}

export interface SellSideFilter {
  sellerSideChow?: boolean;
  hcrisNetIncomeYoyDecline?: boolean;
  hcrisCashYoyDecline?: boolean;
  acquisitionsInMetro?: boolean;
}

export interface TerritoryFilter {
  states?: string[];
  zips?: string[];
  metros?: string[];
  facilityTypes?: string[];
  ownership?: OwnershipFilter;
  financialSize?: FinancialSizeFilter;
  cycle?: CycleFilter;
  serviceMix?: ServiceMixFilter;
  sellSide?: SellSideFilter;
  scoreMin?: number;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: "score_desc" | "score_asc" | "name" | "beds_desc" | "revenue_desc";
  equipmentLineSlug?: string;
}

export interface Territory {
  id: string;
  accountId: string;
  viewKind: ViewKind;
  name: string;
  description: string | null;
  filter: TerritoryFilter;
  equipmentLineSlug: string | null;
  isShared: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TerritoryFacility {
  id: string;
  npi: string;
  name: string;
  facilityType: string;
  doingBusinessAs: string | null;
  cmsId: string | null;
  state: string | null;
  city: string | null;
  zip: string | null;
  lat: string | null;
  lng: string | null;
  signalScore: number | null;
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

export interface EquipmentLineProfile {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  accountId: string | null;
  isSystem: boolean;
  rubric: unknown;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function useListTerritories(viewKind?: ViewKind) {
  const qs = viewKind ? `?viewKind=${viewKind}` : "";
  return useQuery<{ data: Territory[] }, Error>({
    queryKey: ["territories", viewKind ?? "all"],
    queryFn: () => customFetch(`/api/territories${qs}`, { method: "GET", responseType: "json" }),
  });
}

export function useGetTerritory(id: string | undefined) {
  return useQuery<Territory, Error>({
    queryKey: ["territory", id],
    enabled: Boolean(id),
    queryFn: () => customFetch(`/api/territories/${id}`, { method: "GET", responseType: "json" }),
  });
}

export function useGetTerritoryFacilities(
  id: string | undefined,
  params: { limit?: number; offset?: number; sortBy?: string; equipmentLine?: string } = {},
  options?: Omit<UseQueryOptions<TerritoryEvaluation, Error>, "queryKey" | "queryFn" | "enabled"> & { enabled?: boolean },
) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  if (params.sortBy) qs.set("sortBy", params.sortBy);
  if (params.equipmentLine) qs.set("equipmentLine", params.equipmentLine);
  const suffix = qs.toString() ? `?${qs}` : "";
  return useQuery<TerritoryEvaluation, Error>({
    queryKey: ["territory-facilities", id, params],
    enabled: Boolean(id) && (options?.enabled ?? true),
    queryFn: () =>
      customFetch(`/api/territories/${id}/facilities${suffix}`, { method: "GET", responseType: "json" }),
    ...options,
  });
}

export function usePreviewTerritory() {
  return useMutation<
    TerritoryEvaluation,
    Error,
    { filter: TerritoryFilter; viewKind: ViewKind; equipmentLineSlug?: string }
  >({
    mutationFn: (body) =>
      customFetch(`/api/territories/preview`, {
        method: "POST",
        body: JSON.stringify(body),
        responseType: "json",
      }),
  });
}

interface UpsertBody {
  name: string;
  description?: string;
  viewKind: ViewKind;
  filter: TerritoryFilter;
  equipmentLineSlug?: string | null;
  isShared?: boolean;
}

export function useCreateTerritory() {
  const qc = useQueryClient();
  return useMutation<Territory, Error, UpsertBody>({
    mutationFn: (body) =>
      customFetch(`/api/territories`, {
        method: "POST",
        body: JSON.stringify(body),
        responseType: "json",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["territories"] }),
  });
}

export function useUpdateTerritory(id: string) {
  const qc = useQueryClient();
  return useMutation<Territory, Error, UpsertBody>({
    mutationFn: (body) =>
      customFetch(`/api/territories/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
        responseType: "json",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["territories"] });
      qc.invalidateQueries({ queryKey: ["territory", id] });
      qc.invalidateQueries({ queryKey: ["territory-facilities", id] });
    },
  });
}

export function useDeleteTerritory() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      customFetch(`/api/territories/${id}`, { method: "DELETE", responseType: "text" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["territories"] }),
  });
}

export function useListEquipmentLines() {
  return useQuery<{ data: EquipmentLineProfile[] }, Error>({
    queryKey: ["equipment-lines"],
    queryFn: () => customFetch(`/api/equipment-lines`, { method: "GET", responseType: "json" }),
  });
}
