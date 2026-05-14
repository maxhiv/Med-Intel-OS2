import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { customFetch, useGetMe, useListSequences, useCreateCampaign } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Building2,
  CheckCircle2,
  Clock,
  Users,
  Zap,
  ArrowRight,
  RefreshCw,
  GitBranch,
  ListOrdered,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

type LeadTier = "A" | "B" | "C";

interface LeadSignal {
  type: string;
  detectedAt: string | null;
  confidence: number;
}

interface LeadContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  buyingAuthorityScore: number | null;
  humanVerified: boolean | null;
}

interface LeadFYE {
  month: number | null;
  source: string | null;
  daysUntil: number | null;
  timingBonus: number;
  budgetWindowStatus: string;
}

interface Lead {
  facilityId: string;
  name: string;
  city: string | null;
  state: string | null;
  facilityType: string;
  systemName: string | null;
  beds: number | null;
  score: number;
  tier: LeadTier;
  recommendedAction: string;
  urgency: "high" | "medium" | "low";
  topSignals: LeadSignal[];
  crossSourceMatches: string[];
  contacts: LeadContact[];
  fye: LeadFYE;
}

interface LeadsResponse {
  leads: Lead[];
  total: number;
  offset: number;
  limit: number;
}

interface LeadsSummary {
  tierA: number;
  tierB: number;
  tierC: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<string, string> = {
  con_filed: "CON Filed",
  con_approved: "CON Approved",
  bond_issued: "Bond Issued",
  bond_issuance: "Bond Issued",
  rfp_posted: "RFP Posted",
  hcris_depreciation_spike: "Aging Equipment",
  equipment_age_7yr: "Equipment Age 7+",
  high_utilization: "High Utilization",
  grant_awarded: "Grant Awarded",
  clinical_trial: "Clinical Trial",
  sec_capex_flag: "EDGAR CapEx",
  system_signal_propagated: "System Signal",
  nih_grant: "NIH Grant",
  adverse_event_spike: "Adverse Events",
};

const SIGNAL_ICONS: Record<string, string> = {
  con_filed: "📋",
  con_approved: "✅",
  bond_issued: "💰",
  bond_issuance: "💰",
  rfp_posted: "📢",
  hcris_depreciation_spike: "⚙️",
  equipment_age_7yr: "🔧",
  high_utilization: "📈",
  grant_awarded: "🏆",
  clinical_trial: "🔬",
  sec_capex_flag: "🏦",
  system_signal_propagated: "🌐",
  nih_grant: "🔬",
  adverse_event_spike: "⚠️",
};

const EQUIPMENT_TYPES = [
  { value: "imaging", label: "Imaging" },
  { value: "radiology", label: "Radiology" },
  { value: "ultrasound", label: "Ultrasound" },
  { value: "ventilator", label: "Ventilator" },
  { value: "infusion_pump", label: "Infusion Pump" },
  { value: "patient_monitoring", label: "Patient Monitoring" },
  { value: "surgical", label: "Surgical" },
  { value: "laboratory", label: "Laboratory" },
  { value: "sterilization", label: "Sterilization" },
  { value: "defibrillator", label: "Defibrillator" },
];

function tierColor(tier: LeadTier) {
  if (tier === "A") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (tier === "B") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-blue-500/15 text-blue-400 border-blue-500/30";
}

function urgencyBg(urgency: "high" | "medium" | "low") {
  if (urgency === "high") return "border-l-red-500 bg-red-950/20";
  if (urgency === "medium") return "border-l-amber-500 bg-amber-950/20";
  return "border-l-blue-500 bg-blue-950/20";
}

function scoreRingColor(score: number) {
  if (score >= 70) return "text-red-400";
  if (score >= 50) return "text-amber-400";
  return "text-blue-400";
}

function budgetLabel(status: string) {
  if (status === "closing") return { label: "Budget closing", color: "text-red-400" };
  if (status === "active") return { label: "Budget window open", color: "text-amber-400" };
  if (status === "approaching") return { label: "Budget approaching", color: "text-primary" };
  return null;
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

// ─── GHL Pipeline Dialog ──────────────────────────────────────────────────────

function GhlPipelineDialog({
  open,
  onClose,
  lead,
}: {
  open: boolean;
  onClose: () => void;
  lead: Lead;
}) {
  const { data: me } = useGetMe();
  const createCampaign = useCreateCampaign();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const subAccounts = me?.subAccounts ?? [];
  const [selectedSubId, setSelectedSubId] = useState<string>("");

  const chosenId = selectedSubId || subAccounts[0]?.id || "";

  function handleConfirm() {
    if (!chosenId) {
      toast({ title: "No sub-account", description: "Configure a GHL sub-account in Settings.", variant: "destructive" });
      return;
    }
    createCampaign.mutate(
      {
        data: {
          name: `${lead.name} — Pipeline`,
          subAccountId: chosenId,
          description: `Auto-created from Lead Cards for ${lead.name} (Score ${lead.score}, Tier ${lead.tier})`,
        },
      },
      {
        onSuccess: (campaign) => {
          toast({ title: "Added to Pipeline", description: `Campaign created for ${lead.name}.` });
          onClose();
          setLocation(`/campaigns/${campaign.id}`);
        },
        onError: (err) => {
          toast({ title: "Error", description: (err as Error).message || "Failed to create campaign", variant: "destructive" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to GHL Pipeline</DialogTitle>
          <DialogDescription>
            Create a pipeline campaign for <span className="font-medium">{lead.name}</span>.
          </DialogDescription>
        </DialogHeader>
        {subAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No GHL sub-accounts configured. Add one in{" "}
            <Link href="/settings" className="underline text-primary">Settings</Link>.
          </p>
        ) : (
          <div className="py-2 space-y-3">
            {subAccounts.length > 1 && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Sub-account</label>
                <Select value={chosenId} onValueChange={setSelectedSubId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select sub-account" />
                  </SelectTrigger>
                  <SelectContent>
                    {subAccounts.map((s: { id: string; name?: string }) => (
                      <SelectItem key={s.id} value={s.id}>{s.name ?? s.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              A campaign will be created in <span className="font-medium">
                {subAccounts.find((s: { id: string; name?: string }) => s.id === chosenId)?.name ?? subAccounts[0]?.name ?? "your sub-account"}
              </span> for this facility.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleConfirm}
            disabled={createCampaign.isPending || subAccounts.length === 0}
          >
            {createCampaign.isPending ? "Adding…" : "Add to Pipeline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Sequence Selector Dialog ─────────────────────────────────────────────────

function SequenceSelectorDialog({
  open,
  onClose,
  lead,
}: {
  open: boolean;
  onClose: () => void;
  lead: Lead;
}) {
  const { data: sequences } = useListSequences();
  const [, setLocation] = useLocation();

  const seqList = sequences ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start Sequence</DialogTitle>
          <DialogDescription>
            Pick a sequence to enroll <span className="font-medium">{lead.name}</span>.
          </DialogDescription>
        </DialogHeader>
        {seqList.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No sequences available. Create one on the{" "}
            <Link href="/sequences" className="underline text-primary">Sequences</Link> page.
          </p>
        ) : (
          <div className="py-2 space-y-1.5 max-h-60 overflow-y-auto">
            {seqList.map((seq) => (
              <button
                key={seq.id}
                className="w-full text-left rounded-md border border-border px-3 py-2.5 text-sm hover:bg-muted/60 transition-colors"
                onClick={() => {
                  onClose();
                  setLocation(`/campaigns?facilityId=${lead.facilityId}&sequenceId=${seq.id}`);
                }}
              >
                <span className="font-medium block">{seq.name}</span>
                {seq.description && (
                  <span className="text-xs text-muted-foreground line-clamp-1">{seq.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Lead Card ────────────────────────────────────────────────────────────────

function LeadCard({ lead }: { lead: Lead }) {
  const bw = budgetLabel(lead.fye.budgetWindowStatus);
  const [ghlOpen, setGhlOpen] = useState(false);
  const [seqOpen, setSeqOpen] = useState(false);

  return (
    <>
      <Card className="bg-card border-border overflow-hidden">
        <div className={cn("border-l-4 pl-0", urgencyBg(lead.urgency))}>
          <CardHeader className="pb-3 pt-4 px-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn("text-xs font-bold px-2 py-0.5 border", tierColor(lead.tier))}>
                    Tier {lead.tier}
                  </Badge>
                  <span className={cn("text-2xl font-bold tabular-nums", scoreRingColor(lead.score))}>
                    {lead.score}
                  </span>
                  <span className="text-xs text-muted-foreground">/ 100</span>
                  {bw && (
                    <span className={cn("text-xs font-medium flex items-center gap-1", bw.color)}>
                      <Clock className="h-3 w-3" />
                      {bw.label}
                    </span>
                  )}
                </div>
                <Link
                  href={`/facilities/${lead.facilityId}`}
                  className="mt-1 text-base font-semibold hover:text-primary hover:underline leading-tight line-clamp-1 block"
                >
                  {lead.name}
                </Link>
                <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span>{lead.facilityType.replace(/_/g, " ")}</span>
                  {lead.city && lead.state && (
                    <>
                      <span>·</span>
                      <span>{lead.city}, {lead.state}</span>
                    </>
                  )}
                  {lead.beds && (
                    <>
                      <span>·</span>
                      <span>{lead.beds} beds</span>
                    </>
                  )}
                  {lead.systemName && lead.systemName !== lead.name && (
                    <>
                      <span>·</span>
                      <span className="text-primary/70">{lead.systemName}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="px-4 pb-4 space-y-3">
            {/* Recommended action */}
            <div className={cn(
              "rounded-md px-3 py-2 border-l-2 text-sm",
              lead.urgency === "high" ? "bg-red-950/30 border-red-500 text-red-300" :
              lead.urgency === "medium" ? "bg-amber-950/30 border-amber-500 text-amber-300" :
              "bg-blue-950/30 border-blue-500 text-blue-300",
            )}>
              <span className="font-medium">Recommended: </span>
              {lead.recommendedAction}
            </div>

            {/* Signals */}
            {lead.topSignals.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {lead.topSignals.map((sig, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-xs bg-muted/60 rounded-full px-2.5 py-1 border border-border"
                    title={`Confidence: ${sig.confidence}%`}
                  >
                    <span>{SIGNAL_ICONS[sig.type] ?? "📍"}</span>
                    <span>{SIGNAL_LABELS[sig.type] ?? sig.type.replace(/_/g, " ")}</span>
                    <span className="text-muted-foreground">{sig.confidence}%</span>
                  </span>
                ))}
              </div>
            )}

            {/* Cross-source bonuses */}
            {lead.crossSourceMatches.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {lead.crossSourceMatches.map((m, i) => (
                  <Badge key={i} variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
                    <Zap className="h-2.5 w-2.5 mr-1" aria-hidden />
                    {m}
                  </Badge>
                ))}
              </div>
            )}

            {/* Contacts */}
            {lead.contacts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {lead.contacts.slice(0, 2).map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-1.5 text-xs bg-muted/40 rounded-md px-2 py-1 border border-border"
                  >
                    <Users className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium">
                      {[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown"}
                    </span>
                    {c.title && (
                      <span className="text-muted-foreground truncate max-w-[120px]">· {c.title}</span>
                    )}
                    {c.humanVerified && (
                      <CheckCircle2 className="h-3 w-3 text-primary shrink-0" aria-label="Verified" />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1 flex-wrap">
              <Button size="sm" variant="outline" asChild className="flex-1 text-xs h-7 min-w-[120px]">
                <Link href={`/facilities/${lead.facilityId}`}>
                  View Full Profile <ArrowRight className="ml-1 h-3 w-3" />
                </Link>
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="flex-1 text-xs h-7 min-w-[120px]"
                onClick={() => setGhlOpen(true)}
              >
                <GitBranch className="mr-1 h-3 w-3" /> Add to GHL Pipeline
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 text-xs h-7 min-w-[100px] border border-border"
                onClick={() => setSeqOpen(true)}
              >
                <ListOrdered className="mr-1 h-3 w-3" /> Start Sequence
              </Button>
            </div>
          </CardContent>
        </div>
      </Card>

      <GhlPipelineDialog open={ghlOpen} onClose={() => setGhlOpen(false)} lead={lead} />
      <SequenceSelectorDialog open={seqOpen} onClose={() => setSeqOpen(false)} lead={lead} />
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const [tierFilter, setTierFilter] = useState<"" | "A" | "B" | "C">("");
  const [stateFilter, setStateFilter] = useState<string>("");
  const [minScore, setMinScore] = useState<number>(40);
  const [equipmentType, setEquipmentType] = useState<string>("");

  const params = new URLSearchParams();
  if (tierFilter) params.set("tierFilter", tierFilter);
  if (stateFilter) params.set("state", stateFilter);
  if (equipmentType) params.set("equipmentType", equipmentType);
  params.set("minScore", String(minScore));
  params.set("limit", "50");

  const { data, isLoading, refetch, isFetching } = useQuery<LeadsResponse>({
    queryKey: ["leads", tierFilter, stateFilter, minScore, equipmentType],
    queryFn: () => customFetch<LeadsResponse>(`/api/leads?${params}`),
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: summary } = useQuery<LeadsSummary>({
    queryKey: ["leads-summary"],
    queryFn: () => customFetch<LeadsSummary>("/api/leads/summary"),
    refetchInterval: 5 * 60 * 1000,
  });

  const leads = data?.leads ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lead Cards</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Daily top opportunities ranked by purchase intent signals
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-1.5"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { tier: "A" as const, count: summary?.tierA ?? 0, label: "Tier A — High Intent", color: "border-red-500/40 bg-red-950/20 text-red-400" },
          { tier: "B" as const, count: summary?.tierB ?? 0, label: "Tier B — Moderate Intent", color: "border-amber-500/40 bg-amber-950/20 text-amber-400" },
          { tier: "C" as const, count: summary?.tierC ?? 0, label: "Tier C — Nurture", color: "border-blue-500/40 bg-blue-950/20 text-blue-400" },
        ].map(({ tier, count, label, color }) => (
          <button
            key={tier}
            onClick={() => setTierFilter(tierFilter === tier ? "" : tier)}
            className={cn(
              "rounded-lg border p-3 text-left transition-all cursor-pointer hover:opacity-90",
              color,
              tierFilter === tier ? "ring-1 ring-current" : "",
            )}
          >
            <div className="text-2xl font-bold tabular-nums">{count}</div>
            <div className="text-xs font-medium mt-0.5">{label}</div>
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={tierFilter || "all"} onValueChange={(v) => setTierFilter(v === "all" ? "" : v as LeadTier)}>
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue placeholder="All Tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            <SelectItem value="A">Tier A</SelectItem>
            <SelectItem value="B">Tier B</SelectItem>
            <SelectItem value="C">Tier C</SelectItem>
          </SelectContent>
        </Select>

        <Select value={stateFilter || "all"} onValueChange={(v) => setStateFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-28 h-8 text-xs">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="all">All States</SelectItem>
            {US_STATES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={equipmentType || "all"} onValueChange={(v) => setEquipmentType(v === "all" ? "" : v)}>
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue placeholder="Equipment Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Equipment Types</SelectItem>
            {EQUIPMENT_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2 flex-1 min-w-[180px] max-w-xs">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Min Score: {minScore}</span>
          <Slider
            min={0}
            max={90}
            step={5}
            value={[minScore]}
            onValueChange={([v]) => setMinScore(v)}
            className="flex-1"
          />
        </div>

        {(tierFilter || stateFilter || equipmentType || minScore > 40) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => { setTierFilter(""); setStateFilter(""); setEquipmentType(""); setMinScore(40); }}
          >
            Clear Filters
          </Button>
        )}
      </div>

      {/* Cards grid */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-lg" />
          ))}
        </div>
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground space-y-3">
          <Building2 className="h-12 w-12 opacity-20" />
          <div>
            <p className="font-medium">No leads match your filters</p>
            <p className="text-sm mt-1">
              {summary && (summary.tierA + summary.tierB + summary.tierC) === 0
                ? "Track facilities to start seeing leads here."
                : "Try lowering the minimum score or removing filters."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Showing {leads.length} lead{leads.length !== 1 ? "s" : ""}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {leads.map((lead) => (
              <LeadCard key={lead.facilityId} lead={lead} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
