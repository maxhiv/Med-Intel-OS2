/**
 * Opportunity Inbox API hooks. Manual wrappers around customFetch — the
 * endpoints aren't in the OpenAPI spec yet.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

export type OpportunityStatus =
  | "detected"
  | "rep_reviewed"
  | "qualified"
  | "bid_submitted"
  | "won"
  | "lost"
  | "dormant";

export type ActionType =
  | "pursue"
  | "skip"
  | "snooze"
  | "note"
  | "push_to_ghl"
  | "qualify"
  | "disqualify"
  | "won"
  | "lost";

export interface OpportunityListItem {
  id: string;
  accountId: string;
  facilityId: string;
  modality: string;
  verticalSlug: string | null;
  status: OpportunityStatus;
  readinessScore: string | null;
  scoreBreakdown: Record<string, number>;
  estimatedDollarLow: number | null;
  estimatedDollarHigh: number | null;
  primaryTriggerId: string | null;
  topTriggerIds: string[];
  championContactId: string | null;
  economicBuyerContactId: string | null;
  gatekeeperContactId: string | null;
  detectedAt: string | null;
  repReviewedAt: string | null;
  repAssignedTo: string | null;
  snoozedUntil: string | null;
  crmPushedAt: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  facility: {
    id: string;
    name: string;
    facilityType: string;
    city: string | null;
    state: string | null;
    beds: number | null;
    npi: string | null;
  };
}

export interface OpportunityListResponse {
  data: OpportunityListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface OpportunityDetail extends OpportunityListItem {
  triggers: Array<{
    id: string;
    signalType: string;
    signalValue: string | null;
    confidence: number | null;
    source: string;
    metadata: unknown;
    detectedAt: string | null;
  }>;
  decisionMakers: {
    champion: ContactRow | null;
    economicBuyer: ContactRow | null;
    gatekeeper: ContactRow | null;
  };
  actions: Array<{
    id: number;
    actionType: ActionType;
    performedBy: string | null;
    notes: string | null;
    metadata: unknown;
    performedAt: string;
  }>;
}

export interface ContactRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  buyerRole: string | null;
  verificationStatus: string | null;
  confidenceScore: number | null;
}

export function useListOpportunities(params: {
  status?: OpportunityStatus;
  limit?: number;
  offset?: number;
} = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : "";
  return useQuery<OpportunityListResponse, Error>({
    queryKey: ["opportunities", params],
    queryFn: () => customFetch(`/api/opportunities${suffix}`, { method: "GET", responseType: "json" }),
  });
}

export function useGetOpportunity(id: string | undefined) {
  return useQuery<OpportunityDetail, Error>({
    queryKey: ["opportunity", id],
    enabled: Boolean(id),
    queryFn: () => customFetch(`/api/opportunities/${id}`, { method: "GET", responseType: "json" }),
  });
}

export function useRecordAction(id: string) {
  const qc = useQueryClient();
  return useMutation<
    OpportunityListItem,
    Error,
    { actionType: ActionType; notes?: string; snoozeDays?: number; metadata?: Record<string, unknown> }
  >({
    mutationFn: (body) =>
      customFetch(`/api/opportunities/${id}/actions`, {
        method: "POST",
        body: JSON.stringify(body),
        responseType: "json",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["opportunity", id] });
    },
  });
}

export function useRegenerateOpportunities() {
  const qc = useQueryClient();
  return useMutation<{ accountsProcessed: number; opportunitiesCreated: number; opportunitiesUpdated: number }, Error, void>({
    mutationFn: () =>
      customFetch(`/api/opportunities/regenerate`, { method: "POST", responseType: "json" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opportunities"] }),
  });
}
