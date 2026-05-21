/**
 * Paid Sources admin — the v2.0 dual-gate matrix.
 *
 * Each paid source has two independent switches: the system env gate
 * (operator-controlled) and the per-account approval (tenant-admin
 * controlled). A source is callable only when BOTH are on. This page
 * surfaces all three states and lets a tenant admin flip the approval.
 */
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle, MinusCircle, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ApprovalRow {
  sourceName: string;
  sourceCategory: string;
  sourceTier: string | null;
  approved: boolean;
  estimatedMonthlyCostUsd: string | null;
  notes: string | null;
  envVar: string | null;
  envEnabled: boolean | null;
  callableNow: boolean;
}
interface UsageRow {
  sourceName: string;
  successfulCalls: number;
  deniedCalls: number;
  totalCostUsd: string;
  avgLatencyMs: number;
}
interface LimitsRow {
  maxQueriesPerUserPerDay: number;
  maxQueriesPerAccountPerDay: number;
  maxAnthropicCostPerDayUsd: string;
  maxAnthropicCostPerMonthUsd: string;
  hardStopAtLimit: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  anthropic_agent: "Anthropic Agent",
  open_informatics_mcp: "Open-Informatics MCP",
  medintel_proprietary: "MedIntel Proprietary",
};

function GateCell({ on }: { on: boolean | null }) {
  if (on === null) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
        <MinusCircle className="h-3.5 w-3.5" /> n/a
      </span>
    );
  }
  return on ? (
    <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
      <CheckCircle2 className="h-3.5 w-3.5" /> on
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
      <XCircle className="h-3.5 w-3.5" /> off
    </span>
  );
}

export function PaidSourcesAdmin() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const approvalsQ = useQuery({
    queryKey: ["admin", "paid-sources"],
    queryFn: () => customFetch<{ approvals: ApprovalRow[] }>("/api/admin/paid-sources"),
  });
  const usageQ = useQuery({
    queryKey: ["admin", "paid-sources", "usage"],
    queryFn: () =>
      customFetch<{ day: string; sources: UsageRow[] }>("/api/admin/paid-sources/usage"),
  });
  const limitsQ = useQuery({
    queryKey: ["admin", "paid-sources", "limits"],
    queryFn: () => customFetch<{ limits: LimitsRow | null }>("/api/admin/paid-sources/limits"),
  });

  const flip = useMutation({
    mutationFn: (vars: { source: string; approve: boolean }) =>
      customFetch(`/api/admin/paid-sources/${vars.source}/${vars.approve ? "approve" : "revoke"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    onSuccess: (_d, vars) => {
      toast({
        title: vars.approve ? "Source approved" : "Source revoked",
        description: vars.source,
      });
      qc.invalidateQueries({ queryKey: ["admin", "paid-sources"] });
    },
    onError: (err: Error) =>
      toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const approvals = approvalsQ.data?.approvals ?? [];
  const usageBySource = new Map((usageQ.data?.sources ?? []).map((u) => [u.sourceName, u]));
  const limits = limitsQ.data?.limits ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Paid Source Dual-Gate
          </CardTitle>
          <CardDescription>
            Every paid source needs BOTH switches on to be callable: the system env gate
            (operator-controlled) and the account approval (you control). Out of the box every
            source is off — the platform runs on free public data only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {approvalsQ.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : approvals.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground text-sm">
              No paid sources registered for this account yet. Run{" "}
              <code>v2a_seed_paid_sources.sql</code> (via <code>v2_install.sh</code>) to populate
              the catalog.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Source</th>
                    <th className="py-2 pr-3 font-medium">Category</th>
                    <th className="py-2 pr-3 font-medium text-right">Est. $/mo</th>
                    <th className="py-2 pr-3 font-medium text-center">System gate</th>
                    <th className="py-2 pr-3 font-medium text-center">Account approval</th>
                    <th className="py-2 pr-3 font-medium text-center">Callable now</th>
                    <th className="py-2 pr-3 font-medium text-right">Today</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((row) => {
                    const usage = usageBySource.get(row.sourceName);
                    return (
                      <tr key={row.sourceName} className="border-b border-border/50">
                        <td className="py-2.5 pr-3 font-mono text-xs">{row.sourceName}</td>
                        <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                          {CATEGORY_LABEL[row.sourceCategory] ?? row.sourceCategory}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">
                          {row.estimatedMonthlyCostUsd != null
                            ? `$${Number(row.estimatedMonthlyCostUsd).toLocaleString()}`
                            : "—"}
                        </td>
                        <td className="py-2.5 pr-3 text-center">
                          <GateCell on={row.envEnabled} />
                        </td>
                        <td className="py-2.5 pr-3 text-center">
                          {row.approved ? (
                            <Badge variant="secondary" className="text-xs">Approved</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not approved</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-center">
                          {row.callableNow ? (
                            <Badge className="bg-green-600 text-xs">Live</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-xs text-muted-foreground tabular-nums">
                          {usage
                            ? `${usage.successfulCalls} ok / ${usage.deniedCalls} denied`
                            : "—"}
                        </td>
                        <td className="py-2.5 text-right">
                          <Button
                            size="sm"
                            variant={row.approved ? "outline" : "default"}
                            disabled={flip.isPending}
                            onClick={() =>
                              flip.mutate({ source: row.sourceName, approve: !row.approved })
                            }
                          >
                            {row.approved ? "Revoke" : "Approve"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Usage Limits</CardTitle>
          <CardDescription>
            Daily ceilings on ProspectingAgent usage. Operator-managed; reps see a 429 when a
            hard-stop limit is reached.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {limitsQ.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : !limits ? (
            <p className="text-sm text-muted-foreground">
              No explicit limits set — the account runs on env defaults (100 queries/user/day,
              1000/account/day, $50/day Anthropic).
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <Stat label="Queries / user / day" value={limits.maxQueriesPerUserPerDay} />
              <Stat label="Queries / account / day" value={limits.maxQueriesPerAccountPerDay} />
              <Stat label="Anthropic $/day" value={`$${limits.maxAnthropicCostPerDayUsd}`} />
              <Stat label="Anthropic $/month" value={`$${limits.maxAnthropicCostPerMonthUsd}`} />
              <Stat label="Hard stop" value={limits.hardStopAtLimit ? "Yes" : "No (warn only)"} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
