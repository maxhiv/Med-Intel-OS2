import { useParams, Link } from "wouter";
import { useState } from "react";
import {
  useGetFacility,
  useSyncFacilityFromNpi,
  useUpdateFacility,
  customFetch,
} from "@workspace/api-client-react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Building2, Activity, Users, AlertTriangle, Plus, Phone, Mail, MapPin,
  TrendingUp, FileSearch, Stethoscope, RefreshCw, DollarSign, Microscope,
  Zap, Award, BookOpen, CheckCircle2, Globe, Calendar, BedDouble, GraduationCap,
  ShieldCheck, Heart, Hash,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { PurchaseSignal } from "@workspace/api-client-react";

function relativeDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function absoluteDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const SIGNAL_TYPE_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  con_filing:       { icon: FileSearch,    color: "text-red-600",     bg: "bg-red-500/15" },
  clinical_trial:   { icon: Microscope,    color: "text-blue-600",    bg: "bg-blue-500/10" },
  fda_510k:         { icon: Award,         color: "text-purple-600",  bg: "bg-purple-500/10" },
  fda_recall:       { icon: AlertTriangle, color: "text-orange-600",  bg: "bg-orange-500/10" },
  fda_maude:        { icon: AlertTriangle, color: "text-orange-500",  bg: "bg-orange-500/10" },
  equipment_age:    { icon: RefreshCw,     color: "text-yellow-700",  bg: "bg-yellow-500/10" },
  financial_signal: { icon: DollarSign,    color: "text-green-600",   bg: "bg-green-500/10" },
  bond_issuance:    { icon: TrendingUp,    color: "text-emerald-600", bg: "bg-emerald-500/10" },
  grant_award:      { icon: BookOpen,      color: "text-sky-600",     bg: "bg-sky-500/10" },
  sec_edgar:        { icon: DollarSign,    color: "text-indigo-600",  bg: "bg-indigo-500/10" },
  usa_spending:     { icon: DollarSign,    color: "text-teal-600",    bg: "bg-teal-500/10" },
  medicare_util:    { icon: Stethoscope,   color: "text-blue-500",    bg: "bg-blue-500/10" },
};

const DEFAULT_SIGNAL_CONFIG = { icon: Zap, color: "text-primary", bg: "bg-primary/10" };

function getSignalConfig(signalType: string) {
  const key = signalType.toLowerCase().replace(/[\s-]/g, "_");
  return (
    SIGNAL_TYPE_CONFIG[key] ||
    Object.entries(SIGNAL_TYPE_CONFIG).find(([k]) => key.includes(k))?.[1] ||
    DEFAULT_SIGNAL_CONFIG
  );
}

function ConfidenceBadge({ confidence }: { confidence?: number }) {
  if (!confidence) return null;
  const cls =
    confidence >= 80
      ? "bg-green-500/10 text-green-700 border-green-200"
      : confidence >= 60
        ? "bg-yellow-500/10 text-yellow-700 border-yellow-200"
        : "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {confidence}%
    </span>
  );
}

type ActionPriority = "high" | "medium" | "low";
interface RecommendedAction {
  label: string;
  description: string;
  priority: ActionPriority;
  icon: React.ElementType;
}

function deriveRecommendedAction(
  signals: PurchaseSignal[],
  score: number | null | undefined,
): RecommendedAction | null {
  if (!signals.length) return null;
  const types = signals.map((s) => s.signalType.toLowerCase().replace(/[\s-]/g, "_"));
  const has = (fragment: string) => types.some((t) => t.includes(fragment));

  if (has("con") && (has("bond") || has("financial") || has("edgar") || has("spending"))) {
    return { label: "Immediate Outreach", description: "CON filing corroborated by a bond issuance or financial signal — project is funded. Reach out before the contract cycle begins.", priority: "high", icon: CheckCircle2 };
  }
  if (has("recall") || has("maude")) {
    return { label: "Urgent Recall Replacement", description: "Active FDA recall signals a mandatory replacement cycle. This facility likely needs to act within 30–90 days.", priority: "high", icon: AlertTriangle };
  }
  if (has("con")) {
    return { label: "Pipeline Opportunity", description: "Open CON filing indicates planned equipment procurement. Add to pipeline and schedule an intro call.", priority: "high", icon: FileSearch };
  }
  if (has("grant") || has("hrsa") || has("usda")) {
    return { label: "Grant-Funded Outreach", description: "Recent grant award likely earmarked for equipment. Contact the purchasing team before budget is allocated.", priority: "medium", icon: BookOpen };
  }
  if (has("equipment") || has("depreciation") || has("age") || (score ?? 0) >= 60) {
    return { label: "Nurture — High Intent", description: "Equipment depreciation or elevated signal score suggests purchase planning is underway. Add to nurture sequence.", priority: "medium", icon: TrendingUp };
  }
  if (signals.length >= 3) {
    return { label: "Multi-Source Monitor", description: "Multiple data sources are flagging this facility. Continue monitoring — a stronger trigger signal is likely incoming.", priority: "low", icon: Activity };
  }
  return null;
}

function deriveSourceUrl(source: string, signalValue: string): string | null {
  const src = source.toLowerCase();
  const val = signalValue ?? "";
  if (src === "sec_edgar") {
    const accession = val.replace(/[^0-9-]/g, "");
    if (accession) return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=424B&dateb=&owner=include&count=10&search_text=&accession=${accession}`;
  }
  if (src === "usda" || src === "hrsa") {
    const parts = val.split(":");
    const awardId = parts[1] ?? parts[0];
    if (awardId && awardId !== "undefined") return `https://www.usaspending.gov/award/${awardId}/`;
  }
  if (src === "propublica_990" || src === "irs_990") {
    const einMatch = val.match(/:(\d{5,9}):/);
    if (einMatch) return `https://projects.propublica.org/nonprofits/organizations/${einMatch[1]}`;
  }
  if (src === "cms_provider_data") {
    const provMatch = val.match(/cms:([^:]+):/);
    if (provMatch) return `https://www.medicare.gov/care-compare/?providerType=Hospital&providerId=${provMatch[1]}`;
  }
  if (src === "con_filing") return null;
  return null;
}

const PRIORITY_CARD: Record<ActionPriority, string> = {
  high:   "border-red-200 bg-red-50",
  medium: "border-yellow-200 bg-yellow-50",
  low:    "border-blue-200 bg-blue-50",
};
const PRIORITY_TEXT: Record<ActionPriority, string> = {
  high:   "text-red-700",
  medium: "text-yellow-700",
  low:    "text-blue-700",
};

export default function FacilityDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");
  const [editBeds, setEditBeds] = useState("");

  const [addContactOpen, setAddContactOpen] = useState(false);
  const [acFirst, setAcFirst] = useState("");
  const [acLast, setAcLast] = useState("");
  const [acTitle, setAcTitle] = useState("");
  const [acDept, setAcDept] = useState("");
  const [acEmail, setAcEmail] = useState("");
  const [acPhone, setAcPhone] = useState("");

  const { data: facility, isLoading, isError, refetch } = useGetFacility(id, {
    query: { enabled: !!id, retry: 1 },
  });
  const syncFacility = useSyncFacilityFromNpi();
  const updateFacility = useUpdateFacility();

  const addContact = useMutation({
    mutationFn: (data: { firstName?: string; lastName?: string; title?: string; department?: string; email?: string; phone?: string }) =>
      customFetch(`/api/facilities/${id}/contacts`, { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => {
      toast({ title: "Contact added" });
      setAddContactOpen(false);
      setAcFirst(""); setAcLast(""); setAcTitle(""); setAcDept(""); setAcEmail(""); setAcPhone("");
      refetch();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleOpenEdit = () => {
    if (facility) {
      setEditName(facility.name ?? "");
      setEditType(facility.facilityType ?? "");
      setEditBeds(String(facility.beds ?? ""));
    }
    setEditOpen(true);
  };

  const handleSaveEdit = () => {
    updateFacility.mutate(
      { id, data: { name: editName.trim() || undefined, facilityType: editType || undefined, beds: editBeds ? Number(editBeds) : undefined } },
      {
        onSuccess: () => {
          toast({ title: "Facility updated" });
          setEditOpen(false);
          refetch();
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  const handleSync = () => {
    syncFacility.mutate(
      { npi: facility?.npi || "" },
      {
        onSuccess: () => {
          toast({ title: "Sync Complete", description: "Facility data updated from NPI registry." });
          refetch();
        },
        onError: (err) => {
          toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError || !facility) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
        <Building2 className="h-12 w-12 text-muted-foreground opacity-20" />
        <h2 className="text-2xl font-bold">{isError ? "Could Not Load Facility" : "Facility Not Found"}</h2>
        <p className="text-muted-foreground">
          {isError
            ? "There was a problem fetching this facility. It may not be linked to your account."
            : "The requested facility could not be found."}
        </p>
        <Link href="/facilities" className="text-primary hover:underline text-sm flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to Facilities
        </Link>
      </div>
    );
  }

  const signals = [...(facility.signals ?? [])].sort((a, b) => {
    const ta = a.detectedAt ? new Date(a.detectedAt).getTime() : 0;
    const tb = b.detectedAt ? new Date(b.detectedAt).getTime() : 0;
    return tb - ta;
  });

  const distinctSources = new Set(signals.map((s) => s.source)).size;
  const recommendedAction = deriveRecommendedAction(signals, facility.signalScore);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">{facility.name}</h1>
            <div className="bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider">
              {facility.facilityType}
            </div>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
            <span className="flex items-center gap-1"><MapPin className="h-4 w-4" /> {facility.city}, {facility.state}</span>
            <span>NPI: {facility.npi}</span>
            {facility.beds && <span>{facility.beds} Beds</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncFacility.isPending}>
            {syncFacility.isPending ? "Syncing…" : "Sync from NPI"}
          </Button>
          <Button onClick={handleOpenEdit}>Edit Facility</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Sidebar */}
        <div className="md:col-span-1 space-y-4">
          {/* Signal Score */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Signal Score</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold text-primary">{facility.signalScore ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Aggregate purchase intent</p>
              {distinctSources > 0 && (
                <div className="mt-2 flex items-center gap-1.5">
                  <Badge variant="secondary" className="text-xs">{distinctSources} source{distinctSources !== 1 ? "s" : ""}</Badge>
                  <span className="text-xs text-muted-foreground">corroborate</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recommended Action */}
          {recommendedAction && (
            <Card className={`border ${PRIORITY_CARD[recommendedAction.priority]}`}>
              <CardHeader className="pb-2">
                <CardTitle className={`text-sm flex items-center gap-2 ${PRIORITY_TEXT[recommendedAction.priority]}`}>
                  <recommendedAction.icon className="h-4 w-4" />
                  Recommended Action
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`font-semibold text-sm mb-1 ${PRIORITY_TEXT[recommendedAction.priority]}`}>
                  {recommendedAction.label}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{recommendedAction.description}</p>
                <div className="mt-2">
                  <span className={`text-xs font-medium uppercase tracking-wide ${PRIORITY_TEXT[recommendedAction.priority]}`}>
                    {recommendedAction.priority} priority
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Org Details */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Organization Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              {[
                { icon: Building2,     label: "Ownership",        value: facility.ownership || "Unknown" },
                { icon: Hash,          label: "NPI",              value: facility.npi },
                { icon: BedDouble,     label: "Licensed Beds",    value: facility.beds ? String(facility.beds) : null },
                { icon: MapPin,        label: "Address",          value: [facility.address1, facility.city, facility.state, facility.zip].filter(Boolean).join(", ") || null },
                { icon: MapPin,        label: "County",           value: facility.county || null },
                { icon: TrendingUp,    label: "System",           value: facility.systemName || "Independent" },
                { icon: GraduationCap, label: "Teaching Hospital",value: facility.teachingHospital ? "Yes" : "No" },
                { icon: ShieldCheck,   label: "Critical Access",  value: facility.cahDesignation ? "Yes" : null },
                { icon: Heart,         label: "FQHC",             value: facility.fqhcDesignation ? "Yes" : null },
                { icon: Calendar,      label: "Fiscal Year End",  value: facility.fiscalYearEndMonth ? `Month ${facility.fiscalYearEndMonth}` : null },
                { icon: DollarSign,    label: "DSH %",            value: facility.dshPct ? `${facility.dshPct}%` : null },
                { icon: Calendar,      label: "Last Enriched",    value: facility.lastEnrichedAt ? new Date(facility.lastEnrichedAt).toLocaleDateString() : null },
              ].filter(r => r.value).map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-muted-foreground text-xs leading-none mb-0.5">{label}</div>
                    <div className="font-medium text-xs leading-snug break-words">{value}</div>
                  </div>
                </div>
              ))}
              {facility.website && (
                <a
                  href={facility.website.startsWith("http") ? facility.website : `https://${facility.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-primary hover:underline text-xs"
                >
                  <Globe className="h-3.5 w-3.5" />
                  {facility.website}
                </a>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Main tabs */}
        <div className="md:col-span-3">
          <Tabs defaultValue="signals" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="signals">
                Signals
                {signals.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs h-4 px-1">{signals.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="contacts">
                Contacts
                {(facility.contacts?.length ?? 0) > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs h-4 px-1">{facility.contacts!.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="equipment">
                Equipment
                {(facility.equipment?.length ?? 0) > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-xs h-4 px-1">{facility.equipment!.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="financials">Financials</TabsTrigger>
            </TabsList>

            {/* Signals tab */}
            <TabsContent value="signals" className="mt-4 space-y-4">
              {/* Cross-source match badges */}
              {distinctSources > 1 && (
                <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/30 rounded-lg border border-border">
                  <span className="text-xs font-medium text-muted-foreground">Cross-source matches:</span>
                  {Array.from(new Set(signals.map((s) => s.source))).map((src) => {
                    const cnt = signals.filter((s) => s.source === src).length;
                    return (
                      <Badge key={src} variant="outline" className="text-xs font-mono">
                        {src} ({cnt})
                      </Badge>
                    );
                  })}
                </div>
              )}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Signal Timeline</CardTitle>
                  <CardDescription>
                    {signals.length > 0
                      ? `${signals.length} signal${signals.length !== 1 ? "s" : ""} detected across ${distinctSources} data source${distinctSources !== 1 ? "s" : ""}`
                      : "No purchase intent signals detected yet"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {signals.length > 0 ? (
                    <div className="relative pl-2">
                      <div className="absolute left-7 top-2 bottom-2 w-px bg-border" />
                      <div className="space-y-0">
                        {signals.map((signal, idx) => {
                          const cfg = getSignalConfig(signal.signalType);
                          const Icon = cfg.icon;
                          const isLatest = idx === 0;
                          const isLast = idx === signals.length - 1;
                          return (
                            <div key={signal.id} className={`relative flex gap-4 ${isLast ? "pb-0" : "pb-6"}`}>
                              <div
                                className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-background ${cfg.bg} ${isLatest ? "ring-2 ring-primary/30" : ""}`}
                              >
                                <Icon className={`h-4 w-4 ${cfg.color}`} />
                              </div>
                              <div className="flex-1 pt-1.5 min-w-0">
                                <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-medium text-sm">{signal.signalType}</span>
                                    {isLatest && (
                                      <Badge variant="secondary" className="text-xs h-4 px-1">Latest</Badge>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <ConfidenceBadge confidence={signal.confidence} />
                                    <span
                                      className="text-xs text-muted-foreground"
                                      title={absoluteDate(signal.detectedAt)}
                                    >
                                      {relativeDate(signal.detectedAt)}
                                    </span>
                                  </div>
                                </div>
                                <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span>Source: <span className="font-mono">{signal.source}</span></span>
                                  {signal.signalValue && (
                                    <span className="text-foreground/70 truncate max-w-[200px]">— {signal.signalValue}</span>
                                  )}
                                  {deriveSourceUrl(signal.source, signal.signalValue ?? "") && (
                                    <a
                                      href={deriveSourceUrl(signal.source, signal.signalValue ?? "")!}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-0.5 text-primary hover:underline shrink-0"
                                    >
                                      <ExternalLink className="h-3 w-3" /> View Source
                                    </a>
                                  )}
                                </div>
                                {signal.isActive === false && (
                                  <span className="text-xs text-muted-foreground italic">Inactive</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="py-12 text-center text-muted-foreground">
                      <Activity className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No signals detected for this facility yet.</p>
                      <p className="text-xs mt-1">Signals appear as ingestors process public data sources daily.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Contacts tab */}
            <TabsContent value="contacts" className="mt-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>Key Contacts</CardTitle>
                    <CardDescription>Decision makers and technical staff</CardDescription>
                  </div>
                  <Button size="sm" onClick={() => setAddContactOpen(true)}><Plus className="h-4 w-4 mr-1" /> Add Contact</Button>
                </CardHeader>
                <CardContent>
                  {facility.contacts && facility.contacts.length > 0 ? (
                    <div className="divide-y border border-border rounded-md">
                      {facility.contacts.map((contact) => (
                        <div key={contact.id} className="p-4 flex items-center justify-between hover:bg-muted/30">
                          <div className="flex items-center gap-4">
                            <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center font-semibold text-secondary-foreground">
                              {contact.firstName?.[0]}{contact.lastName?.[0]}
                            </div>
                            <div>
                              <div className="font-medium">{contact.firstName} {contact.lastName}</div>
                              <div className="text-sm text-muted-foreground">{contact.title} • {contact.department}</div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {contact.email && (
                              <Button variant="ghost" size="icon" title={contact.email}><Mail className="h-4 w-4" /></Button>
                            )}
                            {contact.phone && (
                              <Button variant="ghost" size="icon" title={contact.phone}><Phone className="h-4 w-4" /></Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      <Users className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No contacts found for this facility.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Equipment tab */}
            <TabsContent value="equipment" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Installed Equipment Base</CardTitle>
                  <CardDescription>Known active capital equipment</CardDescription>
                </CardHeader>
                <CardContent>
                  {facility.equipment && facility.equipment.length > 0 ? (
                    <div className="divide-y border border-border rounded-md">
                      {facility.equipment.map((eq) => (
                        <div key={eq.id} className="p-4 flex items-center justify-between">
                          <div>
                            <div className="font-medium">{eq.modality}</div>
                            {eq.manufacturer && (
                              <div className="text-sm text-muted-foreground">{eq.manufacturer} {eq.model}</div>
                            )}
                          </div>
                          <div className="text-right text-sm">
                            {eq.installYear && (
                              <div className="text-muted-foreground">Installed {eq.installYear}</div>
                            )}
                            {eq.urgencyTier && (
                              <div className={`text-xs font-medium ${eq.urgencyTier === "urgent" ? "text-red-600" : eq.urgencyTier === "near" ? "text-yellow-700" : "text-muted-foreground"}`}>
                                {eq.urgencyTier === "urgent" ? "Urgent replacement" : eq.urgencyTier === "near" ? "Near end-of-life" : "Active"}
                              </div>
                            )}
                            {eq.estReplacementYear && (
                              <div className="text-xs text-primary font-semibold">Est. replace {eq.estReplacementYear}</div>
                            )}
                            {eq.pctDepreciated != null && (
                              <div className="text-xs text-muted-foreground">{Math.round(Number(eq.pctDepreciated))}% depreciated</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No equipment records found for this facility.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            {/* Financials tab */}
            <TabsContent value="financials" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Financial Intelligence</CardTitle>
                  <CardDescription>990 data, HCRIS reports, and bond filings</CardDescription>
                </CardHeader>
                <CardContent>
                  {(facility as any).financialDocs && (facility as any).financialDocs.length > 0 ? (
                    <div className="space-y-4">
                      {(facility as any).financialDocs.map((doc: any) => (
                        <div key={doc.id} className="p-4 border rounded-md space-y-2">
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="font-medium text-sm">{doc.docType} — FY {doc.fiscalYear}</div>
                              {doc.totalRevenue && (
                                <div className="text-xs text-muted-foreground">
                                  Revenue: ${Number(doc.totalRevenue).toLocaleString()}
                                </div>
                              )}
                            </div>
                            {doc.sourceUrl && (
                              <a
                                href={doc.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline text-xs"
                              >
                                <ExternalLink className="h-3.5 w-3.5" /> Source
                              </a>
                            )}
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                            {doc.operatingIncome != null && (
                              <div>
                                <span className="text-muted-foreground">Op. Income: </span>
                                <span className={Number(doc.operatingIncome) >= 0 ? "text-green-700" : "text-red-600"}>
                                  ${Number(doc.operatingIncome).toLocaleString()}
                                </span>
                              </div>
                            )}
                            {doc.capitalExpenditures != null && (
                              <div>
                                <span className="text-muted-foreground">CapEx: </span>
                                ${Number(doc.capitalExpenditures).toLocaleString()}
                              </div>
                            )}
                            {doc.longTermDebt != null && (
                              <div>
                                <span className="text-muted-foreground">LT Debt: </span>
                                ${Number(doc.longTermDebt).toLocaleString()}
                              </div>
                            )}
                            {doc.daysCashOnHand != null && (
                              <div>
                                <span className="text-muted-foreground">Days Cash: </span>
                                {Number(doc.daysCashOnHand).toFixed(0)}
                              </div>
                            )}
                          </div>
                          {doc.rawText && (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer hover:text-foreground">View extracted text</summary>
                              <pre className="mt-2 whitespace-pre-wrap text-xs bg-muted/30 p-2 rounded max-h-40 overflow-y-auto">{doc.rawText}</pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No financial documents on file yet.</p>
                      <p className="text-xs mt-1">Documents are populated by the IRS 990 and HCRIS ingestors.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

          </Tabs>
        </div>
      </div>

      <Dialog open={addContactOpen} onOpenChange={setAddContactOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Contact</DialogTitle>
            <DialogDescription>Manually add a decision-maker or staff member to this facility.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="ac-first">First Name</Label>
                <Input id="ac-first" value={acFirst} onChange={(e) => setAcFirst(e.target.value)} placeholder="Jane" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ac-last">Last Name</Label>
                <Input id="ac-last" value={acLast} onChange={(e) => setAcLast(e.target.value)} placeholder="Smith" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ac-title">Title</Label>
              <Input id="ac-title" value={acTitle} onChange={(e) => setAcTitle(e.target.value)} placeholder="Director of Imaging" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ac-dept">Department</Label>
              <Input id="ac-dept" value={acDept} onChange={(e) => setAcDept(e.target.value)} placeholder="Radiology" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ac-email">Email</Label>
              <Input id="ac-email" type="email" value={acEmail} onChange={(e) => setAcEmail(e.target.value)} placeholder="jsmith@facility.org" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ac-phone">Phone</Label>
              <Input id="ac-phone" type="tel" value={acPhone} onChange={(e) => setAcPhone(e.target.value)} placeholder="312-555-0100" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddContactOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addContact.mutate({ firstName: acFirst, lastName: acLast, title: acTitle, department: acDept, email: acEmail, phone: acPhone })}
              disabled={addContact.isPending || (!acFirst && !acLast)}
            >
              {addContact.isPending ? "Adding…" : "Add Contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Facility</DialogTitle>
            <DialogDescription>Update facility name, type, and bed count.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="fac-name">Name</Label>
              <Input id="fac-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fac-type">Facility Type</Label>
              <Select value={editType} onValueChange={setEditType}>
                <SelectTrigger id="fac-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Hospital">Hospital</SelectItem>
                  <SelectItem value="Ambulatory Surgery Center">Ambulatory Surgery Center</SelectItem>
                  <SelectItem value="Imaging Center">Imaging Center</SelectItem>
                  <SelectItem value="Cancer Center">Cancer Center</SelectItem>
                  <SelectItem value="Dialysis Center">Dialysis Center</SelectItem>
                  <SelectItem value="Critical Access Hospital">Critical Access Hospital</SelectItem>
                  <SelectItem value="Physician Office">Physician Office</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="fac-beds">Beds</Label>
              <Input id="fac-beds" type="number" min={0} value={editBeds} onChange={(e) => setEditBeds(e.target.value)} placeholder="Leave blank if not applicable" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={updateFacility.isPending}>
              {updateFacility.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
