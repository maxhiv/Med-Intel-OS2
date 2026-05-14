import { useState } from "react";
import { useListFacilities, useCreateFacilityFromNpi } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Building2, Search, Plus, MapPin, Activity, BookmarkCheck, Bookmark, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const US_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
  { code: "DC", name: "Washington D.C." },
];

const FACILITY_TYPES = [
  { value: "hospital", label: "Hospital" },
  { value: "imaging_center", label: "Imaging Center" },
  { value: "outpatient_clinic", label: "Outpatient Clinic" },
  { value: "radiology_practice", label: "Radiology Practice" },
  { value: "laboratory", label: "Laboratory" },
  { value: "surgery_center", label: "Surgery Center" },
  { value: "ems", label: "EMS" },
  { value: "dme_supplier", label: "DME Supplier" },
];

const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  FACILITY_TYPES.map((t) => [t.value, t.label])
);

interface SignalBreakdown {
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  crossSourceBonuses: string[];
  topSignals: Array<{ signalType: string; weight: number }>;
}

function scoreColor(score: number): { bg: string; text: string; border: string; label: string } {
  if (score >= 81) return { bg: "bg-red-500/15", text: "text-red-700", border: "border-red-300", label: "Critical" };
  if (score >= 60) return { bg: "bg-orange-500/15", text: "text-orange-700", border: "border-orange-300", label: "High" };
  if (score >= 31) return { bg: "bg-yellow-500/15", text: "text-yellow-700", border: "border-yellow-300", label: "Medium" };
  return { bg: "bg-muted", text: "text-muted-foreground", border: "border-border", label: "Low" };
}

function SignalScoreBadge({ score, breakdown }: { score: number; breakdown?: SignalBreakdown | null }) {
  const colors = scoreColor(score);
  const trigger = (
    <div
      className={`inline-flex items-center gap-1 font-bold px-2 py-1 rounded border text-xs cursor-pointer ${colors.bg} ${colors.text} ${colors.border}`}
    >
      <Activity className="h-3 w-3" />
      {score}
    </div>
  );

  if (!breakdown) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        <div className="space-y-2 text-xs">
          <div className="font-semibold text-sm">{colors.label} Priority (score: {score})</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="font-bold text-red-600">{breakdown.tier1Count}</div>
              <div className="text-muted-foreground">Tier 1</div>
            </div>
            <div>
              <div className="font-bold text-orange-600">{breakdown.tier2Count}</div>
              <div className="text-muted-foreground">Tier 2</div>
            </div>
            <div>
              <div className="font-bold text-muted-foreground">{breakdown.tier3Count}</div>
              <div className="text-muted-foreground">Tier 3</div>
            </div>
          </div>
          {breakdown.topSignals.length > 0 && (
            <div>
              <div className="font-medium mb-1">Top signals:</div>
              {breakdown.topSignals.slice(0, 3).map((s) => (
                <div key={s.signalType} className="flex justify-between">
                  <span className="font-mono">{s.signalType.replace(/_/g, " ")}</span>
                  <span className="text-primary">+{s.weight}</span>
                </div>
              ))}
            </div>
          )}
          {breakdown.crossSourceBonuses.length > 0 && (
            <div className="border-t pt-1">
              <div className="font-medium mb-1">Cross-source bonuses:</div>
              {breakdown.crossSourceBonuses.map((b) => (
                <div key={b} className="text-primary text-xs">{b}</div>
              ))}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export default function FacilitiesPage() {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<string>("all");
  const [facilityType, setFacilityType] = useState<string>("all");
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [highPriorityOnly, setHighPriorityOnly] = useState(false);
  const [npiInput, setNpiInput] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState<"signal_desc" | "signal_asc" | "name">("signal_desc");
  const { toast } = useToast();
  const limit = 50;

  const { data: facilitiesRes, isLoading, refetch } = useListFacilities({
    search: search || undefined,
    state: state !== "all" ? state : undefined,
    facilityType: facilityType !== "all" ? facilityType : undefined,
    trackedOnly: trackedOnly ? "true" : undefined,
    limit,
    offset: page * limit,
  } as Parameters<typeof useListFacilities>[0]);

  const createFacility = useCreateFacilityFromNpi();

  const handleTrack = (npi: string) => {
    createFacility.mutate({ data: { npi } }, {
      onSuccess: () => {
        toast({ title: "Now Tracking", description: "Facility added to your tracked list." });
        refetch();
      },
      onError: (err) => {
        toast({ title: "Error", description: err.message || "Failed to track facility", variant: "destructive" });
      }
    });
  };

  const handleCreateFacility = () => {
    if (npiInput.length !== 10) {
      toast({ title: "Invalid NPI", description: "NPI must be exactly 10 digits", variant: "destructive" });
      return;
    }
    createFacility.mutate({ data: { npi: npiInput } }, {
      onSuccess: () => {
        toast({ title: "Facility Added", description: "Facility pulled from NPI registry and added to tracking." });
        setCreateDialogOpen(false);
        setNpiInput("");
        refetch();
      },
      onError: (err) => {
        toast({ title: "Error", description: err.message || "Failed to create facility", variant: "destructive" });
      }
    });
  };

  const total = facilitiesRes?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  let displayData = facilitiesRes?.data ?? [];

  if (highPriorityOnly) {
    displayData = displayData.filter((f) => (f.signalScore ?? 0) >= 60);
  }

  if (sortBy === "signal_desc") {
    displayData = [...displayData].sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
  } else if (sortBy === "signal_asc") {
    displayData = [...displayData].sort((a, b) => (a.signalScore ?? 0) - (b.signalScore ?? 0));
  } else if (sortBy === "name") {
    displayData = [...displayData].sort((a, b) => a.name.localeCompare(b.name));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Facilities</h1>
          <p className="text-muted-foreground">
            Browse {total > 0 ? total.toLocaleString() : ""} healthcare facilities. Track the ones you want to monitor.
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button
            variant={highPriorityOnly ? "default" : "outline"}
            onClick={() => { setHighPriorityOnly(!highPriorityOnly); setPage(0); }}
            size="sm"
          >
            <AlertTriangle className="mr-2 h-4 w-4" />
            {highPriorityOnly ? "High Priority" : "All Scores"}
          </Button>
          <Button
            variant={trackedOnly ? "default" : "outline"}
            onClick={() => { setTrackedOnly(!trackedOnly); setPage(0); }}
            size="sm"
          >
            <BookmarkCheck className="mr-2 h-4 w-4" />
            {trackedOnly ? "Tracked Only" : "All Facilities"}
          </Button>

          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" /> Add by NPI
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Facility by NPI</DialogTitle>
                <DialogDescription>
                  Enter a 10-digit NPI to pull facility details and add it to your tracked list.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Input
                  placeholder="e.g. 1234567890"
                  value={npiInput}
                  onChange={e => setNpiInput(e.target.value.replace(/\D/g, '').slice(0, 10))}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleCreateFacility} disabled={createFacility.isPending}>
                  {createFacility.isPending ? "Adding..." : "Add Facility"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card className="bg-card">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search facilities..."
                className="pl-9"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              />
            </div>
            <div className="flex gap-2 w-full sm:w-auto flex-wrap">
              <Select value={state} onValueChange={(v) => { setState(v); setPage(0); }}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="All States" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="all">All States</SelectItem>
                  {US_STATES.map((s) => (
                    <SelectItem key={s.code} value={s.code}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={facilityType} onValueChange={(v) => { setFacilityType(v); setPage(0); }}>
                <SelectTrigger className="w-[175px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {FACILITY_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="signal_desc">Score: High → Low</SelectItem>
                  <SelectItem value="signal_asc">Score: Low → High</SelectItem>
                  <SelectItem value="name">Name A–Z</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Facility</th>
                  <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Type & Location</th>
                  <th className="h-10 px-4 text-right font-medium">Signal Score</th>
                  <th className="h-10 px-4 text-right font-medium hidden lg:table-cell">NPI</th>
                  <th className="h-10 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array(8).fill(0).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-4"><Skeleton className="h-5 w-48" /></td>
                      <td className="p-4 hidden md:table-cell"><Skeleton className="h-5 w-32" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right hidden lg:table-cell"><Skeleton className="h-5 w-24 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-8 w-20 ml-auto" /></td>
                    </tr>
                  ))
                ) : displayData.length > 0 ? (
                  displayData.map((facility) => {
                    const score = facility.signalScore ?? 0;
                    const breakdown = (facility as { signalBreakdown?: SignalBreakdown | null }).signalBreakdown;
                    return (
                      <tr key={facility.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <Link href={`/facilities/${facility.id}`} className="font-medium text-primary hover:underline">
                              {facility.name}
                            </Link>
                            {(facility as { tracked?: boolean }).tracked && (
                              <Badge variant="secondary" className="text-xs px-1.5 py-0">Tracked</Badge>
                            )}
                          </div>
                          {facility.systemName && (
                            <div className="text-xs text-muted-foreground mt-0.5">{facility.systemName}</div>
                          )}
                        </td>
                        <td className="p-4 hidden md:table-cell">
                          <div className="flex items-center gap-2 text-sm">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span>{TYPE_LABELS[facility.facilityType] ?? facility.facilityType}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-muted-foreground text-xs">
                            <MapPin className="h-3 w-3 shrink-0" />
                            {[facility.city, facility.state].filter(Boolean).join(", ")}
                          </div>
                        </td>
                        <td className="p-4 text-right">
                          <SignalScoreBadge score={score} breakdown={breakdown} />
                        </td>
                        <td className="p-4 text-right hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground font-mono">{facility.npi}</span>
                        </td>
                        <td className="p-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {!(facility as { tracked?: boolean }).tracked && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleTrack(facility.npi)}
                                disabled={createFacility.isPending}
                              >
                                <Bookmark className="h-3 w-3 mr-1" /> Track
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                              <Link href={`/facilities/${facility.id}`}>View</Link>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} className="h-48 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Building2 className="h-8 w-8 mb-2 opacity-20" />
                        <p>No facilities found</p>
                        <p className="text-xs mt-1">Try adjusting your filters.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
              <span>
                Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={page === 0}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
