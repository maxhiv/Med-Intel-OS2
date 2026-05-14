import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Mail, Phone, Building2, AlertTriangle, TrendingUp, Clock } from "lucide-react";

interface TopSignal {
  signalType: string;
  signalDate: string | null;
  confidence: number | null;
  source: string | null;
}

interface LeadContact {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  buyingAuthorityScore: number | null;
}

interface ConFiling {
  status: string | null;
  modality: string | null;
  requestedAmount: number | null;
  filingDate: string | null;
  filingUrl: string | null;
}

interface Lead {
  facilityId: string;
  facilityName: string;
  city: string | null;
  state: string | null;
  facilityType: string | null;
  signalScore: number;
  leadTier: "A" | "B" | "C";
  recommendedAction: string;
  topSignals: TopSignal[];
  signalBreakdown: { tier1Count: number; tier2Count: number; total: number };
  contacts: LeadContact[];
  latestConFiling: ConFiling | null;
}

interface LeadsResponse {
  leads: Lead[];
  total: number;
  limit: number;
  offset: number;
  tierCounts: { A: number; B: number; C: number };
}

function buildLeadsUrl(params: {
  minScore: number;
  state: string;
  tierFilter: string;
  limit: number;
  offset: number;
}) {
  const q = new URLSearchParams();
  q.set("minScore", String(params.minScore));
  q.set("limit", String(params.limit));
  q.set("offset", String(params.offset));
  if (params.state && params.state !== "all") q.set("state", params.state);
  if (params.tierFilter && params.tierFilter !== "all") q.set("tierFilter", params.tierFilter);
  return `/leads?${q.toString()}`;
}

function tierBadge(tier: "A" | "B" | "C") {
  const classes: Record<"A" | "B" | "C", string> = {
    A: "bg-red-100 text-red-700 border-red-200",
    B: "bg-orange-100 text-orange-700 border-orange-200",
    C: "bg-yellow-100 text-yellow-700 border-yellow-200",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${classes[tier]}`}
    >
      TIER {tier}
    </span>
  );
}

function actionBg(action: string) {
  if (action.startsWith("URGENT") || action.startsWith("Active RFP")) {
    return "bg-red-50 border border-red-200 text-red-800";
  }
  if (action.startsWith("CON approved") || action.startsWith("Pre-position")) {
    return "bg-orange-50 border border-orange-200 text-orange-800";
  }
  if (action.includes("Capital") || action.includes("Grant") || action.includes("FYE")) {
    return "bg-yellow-50 border border-yellow-200 text-yellow-800";
  }
  return "bg-muted border text-muted-foreground";
}

function signalIcon(type: string) {
  if (type.includes("con")) return "🏥";
  if (type.includes("bond") || type.includes("grant") || type.includes("nih")) return "💰";
  if (type.includes("rfp")) return "📋";
  if (type.includes("depreciation") || type.includes("hcris")) return "📉";
  if (type.includes("utilization")) return "📊";
  if (type.includes("eol") || type.includes("510k")) return "⚠️";
  if (type.includes("adverse")) return "🚨";
  if (type.includes("trial")) return "🔬";
  if (type.includes("fiscal")) return "📅";
  return "📡";
}

function formatSignalType(type: string) {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function LeadsPage() {
  const [minScore, setMinScore] = useState(40);
  const [state, setState] = useState("all");
  const [tierFilter, setTierFilter] = useState("all");
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data, isLoading } = useQuery<LeadsResponse>({
    queryKey: ["leads", { minScore, state, tierFilter, page }],
    queryFn: () =>
      customFetch<LeadsResponse>(
        buildLeadsUrl({ minScore, state, tierFilter, limit, offset: page * limit }),
      ),
    refetchInterval: 5 * 60 * 1000,
  });

  const leads = data?.leads ?? [];
  const total = data?.total ?? 0;
  const tierCounts = data?.tierCounts ?? { A: 0, B: 0, C: 0 };

  const handleFilterChange = () => setPage(0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Lead Cards</h1>
        <p className="text-muted-foreground">
          Cross-source qualified leads ranked by signal confluence.
        </p>
      </div>

      {/* Tier summary bar */}
      {!isLoading && (
        <div className="flex gap-4 flex-wrap">
          <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border border-red-200 rounded-md">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <span className="text-sm font-semibold text-red-700">{tierCounts.A} Tier A</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-orange-50 border border-orange-200 rounded-md">
            <TrendingUp className="h-4 w-4 text-orange-600" />
            <span className="text-sm font-semibold text-orange-700">{tierCounts.B} Tier B</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-md">
            <Clock className="h-4 w-4 text-yellow-600" />
            <span className="text-sm font-semibold text-yellow-700">{tierCounts.C} Tier C</span>
          </div>
          <span className="text-sm text-muted-foreground self-center ml-2">{total} total leads</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center p-4 bg-card border rounded-lg">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium whitespace-nowrap">Min Score: {minScore}</span>
          <div className="w-32">
            <Slider
              min={0}
              max={100}
              step={5}
              value={[minScore]}
              onValueChange={([v]) => { setMinScore(v); handleFilterChange(); }}
            />
          </div>
        </div>
        <Select
          value={tierFilter}
          onValueChange={(v) => { setTierFilter(v); handleFilterChange(); }}
        >
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="All Tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            <SelectItem value="A">Tier A</SelectItem>
            <SelectItem value="B">Tier B</SelectItem>
            <SelectItem value="C">Tier C</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(v) => { setState(v); handleFilterChange(); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All States" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="IL">Illinois</SelectItem>
            <SelectItem value="CA">California</SelectItem>
            <SelectItem value="NY">New York</SelectItem>
            <SelectItem value="TX">Texas</SelectItem>
            <SelectItem value="FL">Florida</SelectItem>
            <SelectItem value="OH">Ohio</SelectItem>
            <SelectItem value="PA">Pennsylvania</SelectItem>
            <SelectItem value="MI">Michigan</SelectItem>
            <SelectItem value="NC">North Carolina</SelectItem>
            <SelectItem value="GA">Georgia</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Lead Cards Grid */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-64 w-full rounded-lg" />
          ))}
        </div>
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
          <Building2 className="h-12 w-12 mb-4 opacity-20" />
          <p className="text-lg font-medium">No leads found</p>
          <p className="text-sm mt-1">
            Try lowering the minimum score or removing filters.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {leads.map((lead) => (
            <div
              key={lead.facilityId}
              className="bg-card border rounded-lg overflow-hidden flex flex-col"
            >
              {/* Card header */}
              <div className="flex items-start justify-between p-4 pb-2 gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {tierBadge(lead.leadTier)}
                    <span className="text-xl font-bold text-primary">{lead.signalScore}</span>
                  </div>
                  <div className="font-semibold text-base mt-1 truncate">{lead.facilityName}</div>
                  <div className="text-xs text-muted-foreground">
                    {lead.city && lead.state ? `${lead.city}, ${lead.state}` : lead.state}
                    {lead.facilityType ? ` · ${lead.facilityType}` : ""}
                  </div>
                </div>
              </div>

              {/* Recommended action */}
              <div className={`mx-4 mb-3 px-3 py-2 rounded text-xs font-medium ${actionBg(lead.recommendedAction)}`}>
                {lead.recommendedAction}
              </div>

              {/* Top signals */}
              {lead.topSignals.length > 0 && (
                <div className="px-4 pb-2 space-y-1">
                  {lead.topSignals.map((sig, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{signalIcon(sig.signalType)}</span>
                      <span className="font-medium text-foreground">
                        {formatSignalType(sig.signalType)}
                      </span>
                      {sig.confidence != null && (
                        <span className="text-xs opacity-60">({sig.confidence}%)</span>
                      )}
                      {sig.signalDate && (
                        <span className="ml-auto opacity-60">
                          {new Date(sig.signalDate).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* CON filing badge */}
              {lead.latestConFiling && (
                <div className="mx-4 mb-2 px-3 py-1.5 bg-primary/5 border border-primary/20 rounded text-xs">
                  <span className="font-semibold text-primary">CON {lead.latestConFiling.status}</span>
                  {lead.latestConFiling.modality && (
                    <span className="text-muted-foreground"> · {lead.latestConFiling.modality}</span>
                  )}
                  {lead.latestConFiling.requestedAmount && (
                    <span className="text-muted-foreground">
                      {" "}
                      · ${(lead.latestConFiling.requestedAmount / 1_000_000).toFixed(1)}M
                    </span>
                  )}
                </div>
              )}

              {/* Contacts strip */}
              {lead.contacts.length > 0 && (
                <div className="px-4 pb-2 flex flex-wrap gap-2">
                  {lead.contacts.slice(0, 2).map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center gap-1.5 text-xs bg-muted/50 px-2 py-1 rounded"
                    >
                      <span className="font-medium truncate max-w-[100px]">{c.name}</span>
                      {c.title && (
                        <span className="text-muted-foreground hidden sm:inline truncate max-w-[80px]">
                          · {c.title}
                        </span>
                      )}
                      {c.email && (
                        <a href={`mailto:${c.email}`} title={c.email}>
                          <Mail className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </a>
                      )}
                      {c.phone && (
                        <a href={`tel:${c.phone}`} title={c.phone}>
                          <Phone className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Footer */}
              <div className="mt-auto p-4 pt-2 border-t flex gap-2">
                <Link href={`/facilities/${lead.facilityId}`} className="flex-1">
                  <Button variant="outline" size="sm" className="w-full">
                    View Profile
                  </Button>
                </Link>
                <div className="text-xs text-muted-foreground self-center">
                  {lead.signalBreakdown.total} signal{lead.signalBreakdown.total !== 1 ? "s" : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-muted-foreground">
            Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * limit >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
