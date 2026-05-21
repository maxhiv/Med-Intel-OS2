import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListConFilings,
  useListConAlertNotifications,
  useMarkAllConAlertNotificationsRead,
  useMarkConAlertNotificationRead,
  getListConAlertNotificationsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Bell, FileSignature, ExternalLink, Building2, AlertTriangle, Check, Settings as SettingsIcon } from "lucide-react";
import { Link } from "wouter";

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

/**
 * Structured fields scraped from the filing PDF. The API returns these ahead of
 * the generated client type, so they're read through a narrow cast.
 */
interface ConFilingScraped {
  county?: string | null;
  projectId?: string | null;
  projectDescription?: string | null;
  stateFacilityId?: string | null;
}
const scraped = (row: object): ConFilingScraped => row as ConFilingScraped;

function StatusBadge({
  normalized,
  raw,
}: {
  normalized: "approved" | "filed" | null | undefined;
  raw: string | null | undefined;
}) {
  if (normalized === "approved") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/20 text-primary"
        title={raw || undefined}
      >
        Approved
      </span>
    );
  }
  if (normalized === "filed") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground"
        title={raw || undefined}
      >
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

function AlertsBanner() {
  const queryClient = useQueryClient();
  const { data } = useListConAlertNotifications(
    { unread: true, limit: 25 },
    { query: { refetchInterval: 600_000 } },
  );

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListConAlertNotificationsQueryKey(),
    });

  const { mutate: markOne } = useMarkConAlertNotificationRead({
    mutation: { onSuccess: invalidate },
  });
  const { mutate: markAll, isPending: markingAll } =
    useMarkAllConAlertNotificationsRead({
      mutation: { onSuccess: invalidate },
    });

  const unread = data?.unread ?? 0;
  const items = data?.data ?? [];
  if (unread === 0) return null;

  return (
    <Card className="bg-primary/5 border-primary/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Bell className="h-5 w-5 text-primary" />
              {unread} new CON {unread === 1 ? "alert" : "alerts"} for your coverage area
            </CardTitle>
            <CardDescription>
              Filings that match your states, modalities, and approval-stage preferences.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="link-alert-prefs"
            >
              <SettingsIcon className="h-3.5 w-3.5" /> Preferences
            </Link>
            <Button
              size="sm"
              variant="outline"
              onClick={() => markAll()}
              disabled={markingAll}
              data-testid="button-mark-all-read"
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              Mark all read
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border rounded-md border border-border bg-background">
          {items.slice(0, 8).map((n) => (
            <li
              key={n.id}
              className="flex items-center justify-between gap-4 px-4 py-2 text-sm"
              data-testid={`alert-row-${n.id}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-xs text-muted-foreground">
                  {n.state}
                </span>
                <span className="font-medium truncate">
                  {n.applicantName || "Unknown applicant"}
                </span>
                {n.modality && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                    {n.modality}
                  </span>
                )}
                {n.statusNormalized === "approved" && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                    Approved
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => markOne({ id: n.id })}
                className="text-xs text-muted-foreground hover:text-foreground"
                data-testid={`button-dismiss-${n.id}`}
              >
                Dismiss
              </button>
            </li>
          ))}
          {items.length > 8 && (
            <li className="px-4 py-2 text-xs text-muted-foreground">
              + {items.length - 8} more
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function ConFilingsPage() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = useListConFilings({
    state: stateFilter !== "all" ? stateFilter : undefined,
    status: statusFilter !== "all" ? (statusFilter as "approved" | "filed") : undefined,
    limit: 100,
  });

  const rows = data?.data ?? [];
  const stateOptions = data?.states ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CON Filings</h1>
        <p className="text-muted-foreground">
          Certificate-of-Need applications detected from state regulators — the highest-intent purchase signal we track.
        </p>
      </div>

      <AlertsBanner />

      <Card className="bg-card">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <CardTitle>Recent filings</CardTitle>
              <CardDescription>
                {data ? `${data.total} total filing${data.total === 1 ? "" : "s"}` : "Loading…"}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-[140px]" data-testid="select-state">
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
                <SelectTrigger className="w-[160px]" data-testid="select-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="filed">Filed</SelectItem>
                </SelectContent>
              </Select>
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
                  <th className="h-10 px-4 text-left font-medium">Modality</th>
                  <th className="h-10 px-4 text-left font-medium">Status</th>
                  <th className="h-10 px-4 text-left font-medium">Filed</th>
                  <th className="h-10 px-4 text-right font-medium">Amount</th>
                  <th className="h-10 px-4 text-right font-medium">Links</th>
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
                        <td className="p-4 font-mono text-xs">{row.state}</td>
                        <td className="p-4 max-w-md">
                          <div className="font-medium text-foreground">{row.applicantName || "Unknown applicant"}</div>
                          {(scraped(row).projectDescription || row.equipmentType) && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {scraped(row).projectDescription || row.equipmentType}
                            </div>
                          )}
                          {(scraped(row).county || scraped(row).projectId) && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              {scraped(row).county && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                  {scraped(row).county} County
                                </span>
                              )}
                              {scraped(row).projectId && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                                  {scraped(row).projectId}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="p-4 text-muted-foreground">{row.modality || "—"}</td>
                        <td className="p-4"><StatusBadge normalized={row.statusNormalized} raw={row.status} /></td>
                        <td className="p-4 text-muted-foreground whitespace-nowrap">{formatDate(row.filingDate)}</td>
                        <td className="p-4 text-right whitespace-nowrap">
                          {formatMoney(amount)}
                          {row.approvedAmount !== null && row.approvedAmount !== undefined && (
                            <div className="text-xs text-primary">approved</div>
                          )}
                        </td>
                        <td className="p-4 text-right">
                          <div className="inline-flex items-center gap-3 justify-end">
                            {row.facilityId && row.facilityAccessible ? (
                              <Link
                                href={`/facilities/${row.facilityId}`}
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                                data-testid={`link-facility-${row.id}`}
                              >
                                <Building2 className="h-3.5 w-3.5" />
                                Facility
                              </Link>
                            ) : row.facilityId ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                                title="Matched facility is outside your account"
                              >
                                <Building2 className="h-3.5 w-3.5" />
                                {row.facilityName || "matched"}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">unmatched</span>
                            )}
                            {row.filingUrl && (
                              <a
                                href={row.filingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                                data-testid={`link-source-${row.id}`}
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Source
                              </a>
                            )}
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
                        <p className="text-xs mt-1">Try clearing the state or status filter.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <FileSignature className="h-3.5 w-3.5" />
        Sourced from state Certificate-of-Need regulators via the CON ingestor.
      </div>
    </div>
  );
}
