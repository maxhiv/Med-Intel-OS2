import { useState, useEffect, useRef } from "react";
import { useSearch } from "wouter";
import { useListConFilings, useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Monitor, ExternalLink, Building2, AlertTriangle, Download, Plus, CheckCircle2, RefreshCw, ChevronDown, Play, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

const TIER_A_STATES = ["IL", "NY", "CT", "MI", "NC", "MA", "MD", "VA", "GA", "OH", "MN"];

const CMX_ALL_STATES = [
  "AL","CA","CT","FL","GA","IL","IN","KY","MA","MD","MI","MN","MO","MS","NC","NY","OH","TN","TX","VA","WA","WI",
];

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${Math.round(value).toLocaleString()}`;
}

function StatusBadge({
  normalized,
  raw,
}: {
  normalized: "approved" | "filed" | null | undefined;
  raw: string | null | undefined;
}) {
  if (normalized === "approved") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/15 text-green-700 border border-green-200" title={raw || undefined}>
        <CheckCircle2 className="h-3 w-3" /> Approved
      </span>
    );
  }
  if (normalized === "filed") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-700 border border-blue-200" title={raw || undefined}>
        Filed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
      {raw || "Unknown"}
    </span>
  );
}

function StateMultiSelect({
  selectedStates,
  onChange,
}: {
  selectedStates: string[];
  onChange: (states: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (state: string) => {
    if (selectedStates.includes(state)) {
      onChange(selectedStates.filter((s) => s !== state));
    } else {
      onChange([...selectedStates, state]);
    }
  };

  const label =
    selectedStates.length === 0
      ? "All states"
      : selectedStates.length <= 3
        ? selectedStates.join(", ")
        : `${selectedStates.length} states`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 min-w-[130px] justify-between font-normal"
          data-testid="select-state"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 ml-1 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2" align="start">
        <div className="flex gap-1 mb-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs flex-1"
            onClick={() => onChange([])}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs flex-1"
            onClick={() => onChange([...TIER_A_STATES])}
          >
            Tier A
          </Button>
        </div>
        <div className="max-h-64 overflow-y-auto space-y-0.5">
          {CMX_ALL_STATES.map((s) => (
            <label
              key={s}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer text-sm"
            >
              <Checkbox
                checked={selectedStates.includes(s)}
                onCheckedChange={() => toggle(s)}
              />
              <span className="font-mono font-medium">{s}</span>
              {TIER_A_STATES.includes(s) && (
                <span className="text-xs text-red-500 ml-auto">A</span>
              )}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface PipelineModalProps {
  filingId: string;
  filingName: string;
  subAccounts: Array<{ id: string; name: string; crmType: string | null }>;
  onClose: () => void;
}

function PipelineModal({ filingId, filingName, subAccounts, onClose }: PipelineModalProps) {
  const { toast } = useToast();
  const [selectedSubAccount, setSelectedSubAccount] = useState(subAccounts[0]?.id ?? "");
  const [isPushing, setIsPushing] = useState(false);
  const [pushed, setPushed] = useState(false);

  const handlePush = async () => {
    if (!selectedSubAccount) return;
    setIsPushing(true);
    try {
      const res = await fetch(`/api/con-filings/${filingId}/push-to-crm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subAccountId: selectedSubAccount }),
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setPushed(true);
      toast({ title: "Added to Pipeline", description: "CON filing pushed to CRM as an opportunity." });
      setTimeout(onClose, 1200);
    } catch (err) {
      toast({ title: "Push failed", description: String(err), variant: "destructive" });
    } finally {
      setIsPushing(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" /> Add to Pipeline
          </DialogTitle>
          <DialogDescription>Create a CRM opportunity from this CON filing.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="bg-muted/40 rounded-md p-3 text-sm">
            <div className="font-medium">{filingName}</div>
          </div>

          {subAccounts.length === 0 ? (
            <div className="text-sm text-muted-foreground bg-yellow-500/10 border border-yellow-200 rounded-md p-3">
              No sub-accounts configured. Ask your admin to set up a sub-account with CRM credentials.
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium mb-2 block">Select sub-account</label>
              <Select value={selectedSubAccount} onValueChange={setSelectedSubAccount}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose sub-account" />
                </SelectTrigger>
                <SelectContent>
                  {subAccounts.map((sa) => (
                    <SelectItem key={sa.id} value={sa.id}>
                      {sa.name} {sa.crmType ? `(${sa.crmType.toUpperCase()})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handlePush}
            disabled={isPushing || pushed || !selectedSubAccount || subAccounts.length === 0}
          >
            {isPushing ? "Pushing…" : pushed ? "Pushed!" : "Add to Pipeline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function exportCsv(rows: {
  state: string;
  applicantName: string | null | undefined;
  equipmentType: string | null | undefined;
  modality: string | null | undefined;
  statusNormalized: string | null | undefined;
  status: string | null | undefined;
  filingDate: Date | string | null | undefined;
  decisionDate: Date | string | null | undefined;
  requestedAmount: number | null | undefined;
  approvedAmount: number | null | undefined;
  filingUrl: string | null | undefined;
}[]) {
  const headers = ["State","Applicant","Equipment Type","Modality","Status","Filed","Decision","Requested","Approved","URL"];
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.state,
        `"${(r.applicantName || "").replace(/"/g, '""')}"`,
        `"${(r.equipmentType || "").replace(/"/g, '""')}"`,
        r.modality || "",
        r.statusNormalized || r.status || "",
        r.filingDate ? new Date(r.filingDate).toISOString().slice(0, 10) : "",
        r.decisionDate ? new Date(r.decisionDate).toISOString().slice(0, 10) : "",
        r.requestedAmount ?? "",
        r.approvedAmount ?? "",
        r.filingUrl || "",
      ].join(",")
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `con-filings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ConMonitorPage() {
  const searchString = useSearch();
  const { toast } = useToast();

  const params = new URLSearchParams(searchString);
  const initialState = params.get("state");

  const [selectedStates, setSelectedStates] = useState<string[]>(
    initialState ? [initialState] : [],
  );
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [equipmentTypeFilter, setEquipmentTypeFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [pipelineModal, setPipelineModal] = useState<{ id: string; name: string } | null>(null);
  const [runningIngest, setRunningIngest] = useState<string | null>(null);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const p = new URLSearchParams(searchString);
    const s = p.get("state");
    if (s) setSelectedStates([s]);
  }, [searchString]);

  const { data: me } = useGetMe();
  const subAccounts = me?.subAccounts ?? [];
  const isAdmin = me?.isPlatformAdmin ?? false;

  const stateParam = selectedStates.length === 1 ? selectedStates[0] : undefined;

  const { data, isLoading, refetch } = useListConFilings({
    state: stateParam,
    status: statusFilter !== "all" ? (statusFilter as "approved" | "filed") : undefined,
    equipmentType: equipmentTypeFilter || undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    limit: 200,
  });

  const allRows = data?.data ?? [];
  const rows = selectedStates.length > 1
    ? allRows.filter((r) => selectedStates.includes(r.state))
    : allRows;

  const hasFilters =
    selectedStates.length > 0 ||
    statusFilter !== "all" ||
    !!equipmentTypeFilter ||
    !!fromDate ||
    !!toDate;

  const triggerIngest = async (label: string) => {
    setRunningIngest(label);
    try {
      const res = await fetch("/api/signals/ingest/con-filings", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { inserted?: number; updated?: number };
      toast({
        title: `${label} refresh complete`,
        description: `Ingested ${body.inserted ?? 0} new filing(s).`,
      });
      refetch();
    } catch (err) {
      toast({ title: "Ingest failed", description: String(err), variant: "destructive" });
    } finally {
      setRunningIngest(null);
    }
  };

  const PER_STATE_REFRESH_STATES = ["CT", "IL", "NY"];
  const showPerStateRefresh = isAdmin && selectedStates.length === 1 && PER_STATE_REFRESH_STATES.includes(selectedStates[0]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">CON Monitor</h1>
          <p className="text-muted-foreground">
            Live Certificate-of-Need pipeline across all tracked states — filter, review, and push to CRM in one place.
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2 items-center">
            {showPerStateRefresh && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => triggerIngest(`${selectedStates[0]} filings`)}
                disabled={!!runningIngest}
                className="text-xs"
              >
                {runningIngest ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                )}
                Refresh {selectedStates[0]}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerIngest("All 11 Tier A States")}
              disabled={!!runningIngest}
              className="text-xs border-red-200 text-red-700 hover:bg-red-50"
            >
              {runningIngest === "All 11 Tier A States" ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 mr-1" />
              )}
              Run All 11 Tier A States
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <CardTitle>CON Filings Monitor</CardTitle>
                <CardDescription>
                  {data
                    ? `${rows.length} filing${rows.length === 1 ? "" : "s"} shown${data.total !== rows.length ? ` of ${data.total} total` : ""}`
                    : "Loading…"}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCsv(rows)}
                disabled={rows.length === 0}
              >
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <StateMultiSelect
                selectedStates={selectedStates}
                onChange={setSelectedStates}
              />

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px] h-9" data-testid="select-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="filed">Filed</SelectItem>
                </SelectContent>
              </Select>

              <Input
                placeholder="Equipment type…"
                className="w-[180px] h-9"
                value={equipmentTypeFilter}
                onChange={(e) => setEquipmentTypeFilter(e.target.value)}
                data-testid="input-equipment-type"
              />

              <Input
                type="date"
                className="w-[150px] h-9"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                title="From date"
                data-testid="input-from-date"
              />

              <Input
                type="date"
                className="w-[150px] h-9"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                title="To date"
                data-testid="input-to-date"
              />

              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedStates([]);
                    setStatusFilter("all");
                    setEquipmentTypeFilter("");
                    setFromDate("");
                    setToDate("");
                  }}
                >
                  Clear filters
                </Button>
              )}

              {selectedStates.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedStates.map((s) => (
                    <Badge
                      key={s}
                      variant="secondary"
                      className="cursor-pointer hover:bg-destructive/10 text-xs font-mono"
                      onClick={() => setSelectedStates(selectedStates.filter((x) => x !== s))}
                    >
                      {s} ×
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">State</th>
                  <th className="h-10 px-4 text-left font-medium">Applicant</th>
                  <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Equipment</th>
                  <th className="h-10 px-4 text-left font-medium">Status</th>
                  <th className="h-10 px-4 text-left font-medium hidden lg:table-cell">Filed</th>
                  <th className="h-10 px-4 text-right font-medium hidden lg:table-cell">Amount</th>
                  <th className="h-10 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array(8).fill(0).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {Array(7).fill(0).map((_, j) => (
                        <td key={j} className="p-4"><Skeleton className="h-4 w-20" /></td>
                      ))}
                    </tr>
                  ))
                ) : rows.length > 0 ? (
                  rows.map((row) => {
                    const amount = row.approvedAmount ?? row.requestedAmount;
                    return (
                      <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`row-con-${row.id}`}>
                        <td className="p-4">
                          <span className="font-mono text-xs font-semibold">{row.state}</span>
                          {TIER_A_STATES.includes(row.state) && (
                            <span className="ml-1.5 text-xs text-red-500 font-medium">A</span>
                          )}
                        </td>
                        <td className="p-4">
                          <div className="font-medium text-foreground">{row.applicantName || "Unknown applicant"}</div>
                          {row.notes && (
                            <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{row.notes}</div>
                          )}
                        </td>
                        <td className="p-4 hidden md:table-cell">
                          <div className="text-sm">{row.equipmentType || "—"}</div>
                          {row.modality && (
                            <div className="text-xs text-muted-foreground font-mono mt-0.5">{row.modality}</div>
                          )}
                        </td>
                        <td className="p-4">
                          <StatusBadge normalized={row.statusNormalized} raw={row.status} />
                        </td>
                        <td className="p-4 hidden lg:table-cell text-muted-foreground whitespace-nowrap">
                          {formatDate(row.filingDate)}
                        </td>
                        <td className="p-4 hidden lg:table-cell text-right whitespace-nowrap">
                          {formatMoney(amount)}
                          {row.approvedAmount != null && (
                            <div className="text-xs text-green-600">approved</div>
                          )}
                        </td>
                        <td className="p-4 text-right">
                          <div className="inline-flex items-center gap-2 justify-end">
                            {row.facilityId && row.facilityAccessible ? (
                              <Link
                                href={`/facilities/${row.facilityId}`}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <Building2 className="h-3.5 w-3.5" />
                                Facility
                              </Link>
                            ) : null}
                            {row.filingUrl && (
                              <a
                                href={row.filingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() =>
                                setPipelineModal({
                                  id: row.id,
                                  name: `${row.applicantName || "Unknown"} — ${row.state}`,
                                })
                              }
                              data-testid={`button-add-pipeline-${row.id}`}
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Pipeline
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={7} className="h-48 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <AlertTriangle className="h-8 w-8 mb-2 opacity-20" />
                        <p>No CON filings match these filters.</p>
                        <p className="text-xs mt-1">Try clearing filters or broadening your search.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {pipelineModal && (
        <PipelineModal
          filingId={pipelineModal.id}
          filingName={pipelineModal.name}
          subAccounts={subAccounts.map((sa) => ({ id: sa.id, name: sa.name, crmType: sa.crmType ?? null }))}
          onClose={() => setPipelineModal(null)}
        />
      )}

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <Monitor className="h-3.5 w-3.5" />
        Sourced from state CON regulators via automated ingestors. Use &quot;Add to Pipeline&quot; to create a CRM opportunity from any filing.
      </div>
    </div>
  );
}
