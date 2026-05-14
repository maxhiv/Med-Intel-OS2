import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { useListConFilings, useGetMe } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Monitor, ExternalLink, Building2, AlertTriangle, Download, Plus, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

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
      const res = await fetch(`/api/signals/con-filings/${filingId}/push-to-crm`, {
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
      toast({ title: "Added to Pipeline", description: `CON filing pushed to CRM as an opportunity.` });
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
          <DialogDescription>
            Create a CRM opportunity from this CON filing.
          </DialogDescription>
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
  const params = new URLSearchParams(searchString);
  const initialState = params.get("state") ?? "all";

  const [stateFilter, setStateFilter] = useState<string>(initialState);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [equipmentTypeFilter, setEquipmentTypeFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [pipelineModal, setPipelineModal] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(searchString);
    const s = p.get("state");
    if (s) setStateFilter(s);
  }, [searchString]);

  const { data: me } = useGetMe();
  const subAccounts = me?.subAccounts ?? [];

  const { data, isLoading } = useListConFilings({
    state: stateFilter !== "all" ? stateFilter : undefined,
    status: statusFilter !== "all" ? (statusFilter as "approved" | "filed") : undefined,
    equipmentType: equipmentTypeFilter || undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    limit: 200,
  });

  const rows = data?.data ?? [];
  const stateOptions = data?.states ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CON Monitor</h1>
        <p className="text-muted-foreground">
          Live Certificate-of-Need pipeline across all tracked states — filter, review, and push to CRM in one place.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <CardTitle>CON Filings Monitor</CardTitle>
                <CardDescription>
                  {data ? `${data.total} total filing${data.total === 1 ? "" : "s"}` : "Loading…"}
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

            <div className="flex flex-wrap gap-2">
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-[130px]" data-testid="select-state">
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All states</SelectItem>
                  {stateOptions.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px]" data-testid="select-status">
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
                className="w-[180px]"
                value={equipmentTypeFilter}
                onChange={(e) => setEquipmentTypeFilter(e.target.value)}
                data-testid="input-equipment-type"
              />

              <Input
                type="date"
                className="w-[150px]"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                title="From date"
                data-testid="input-from-date"
              />

              <Input
                type="date"
                className="w-[150px]"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                title="To date"
                data-testid="input-to-date"
              />

              {(stateFilter !== "all" || statusFilter !== "all" || equipmentTypeFilter || fromDate || toDate) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStateFilter("all");
                    setStatusFilter("all");
                    setEquipmentTypeFilter("");
                    setFromDate("");
                    setToDate("");
                  }}
                >
                  Clear filters
                </Button>
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
                        <td className="p-4 font-mono text-xs font-semibold">{row.state}</td>
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
