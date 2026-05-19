import { useEffect, useState } from "react";
import {
  useGetMe,
  useAdminPlatformStats,
  useAdminListAccounts,
  useAdminListEnrichmentSources,
  useAdminApproveEnrichmentSource,
  useAdminSetEnrichmentSourceBudget,
  useAdminValidationStats,
  useAdminListSubAccounts,
  useAdminEncryptionKeyStatus,
  useAdminEncryptionKeyRotate,
  useAdminEncryptionKeyRotationLog,
  customFetch,
  type SubAccount,
} from "@workspace/api-client-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConReviewQueue } from "./ConReviewQueue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Activity, CheckCircle2, XCircle, AlertTriangle, KeyRound, RefreshCw, Lock, Link2, Database, Play, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { SubAccountCredentialsDialog } from "./sub-account-credentials";
import { WebhookConfigRow } from "@/components/admin/webhook-config-row";

function formatUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function BudgetEditor({
  source,
  initialCents,
  onSave,
  isPending,
}: {
  source: string;
  initialCents: number | null;
  onSave: (cents: number | null) => void;
  isPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    initialCents == null ? "" : (initialCents / 100).toFixed(2),
  );

  if (!editing) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setValue(initialCents == null ? "" : (initialCents / 100).toFixed(2));
          setEditing(true);
        }}
        data-testid={`button-edit-budget-${source}`}
      >
        Set Budget
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">$</span>
      <Input
        type="number"
        min={0}
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="No cap"
        className="w-28 h-8"
        data-testid={`input-budget-${source}`}
      />
      <Button
        size="sm"
        disabled={isPending}
        onClick={() => {
          const trimmed = value.trim();
          if (trimmed === "") {
            onSave(null);
          } else {
            const dollars = Number(trimmed);
            if (!Number.isFinite(dollars) || dollars < 0) return;
            onSave(Math.round(dollars * 100));
          }
          setEditing(false);
        }}
        data-testid={`button-save-budget-${source}`}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

interface IngestJob {
  status: "idle" | "running" | "done" | "error";
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  states: string[];
  signalsInserted: number;
  facilitiesScanned: number;
  errors: number;
  currentSource: string | null;
  completedSources: string[];
  errorMessage?: string;
}

interface IngestRun {
  id: string;
  jobId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  signalsInserted: number;
  facilitiesScanned: number;
  errors: number;
  states: string[];
  limitPerSource: number;
  errorMessage: string | null;
}

interface IngestStatus {
  job: IngestJob;
  bySource: { source: string; count: number }[];
  byState: { state: string; totalFacilities: number; facilitiesWithSignals: number; totalSignals: number }[];
  top20States: string[];
  recentRuns: IngestRun[];
}

function jobStatusBadge(status: IngestJob["status"]) {
  if (status === "running") return <Badge className="bg-blue-500 text-white">Running</Badge>;
  if (status === "done")    return <Badge className="bg-green-600 text-white">Done</Badge>;
  if (status === "error")   return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">Idle</Badge>;
}

function NationalIngestPanel() {
  const { toast } = useToast();
  const [allStates, setAllStates] = useState(false);

  const statusQ = useQuery<IngestStatus>({
    queryKey: ["admin", "ingest", "status"],
    queryFn: () => customFetch("/api/admin/ingest/status"),
    refetchInterval: (query) => {
      const status = (query.state.data as IngestStatus | undefined)?.job?.status;
      return status === "running" ? 2_000 : 30_000;
    },
  });

  const triggerMut = useMutation<{ started: boolean; job: IngestJob }, Error, { allStates: boolean }>({
    mutationFn: (vars) =>
      customFetch("/api/admin/ingest/national", {
        method: "POST",
        body: JSON.stringify({ allStates: vars.allStates, recomputeScores: true }),
      }),
    onSuccess: (data) => {
      if (data.started) {
        toast({ title: "National ingest started", description: `Job ${data.job.jobId.slice(0, 8)}… running in background` });
      } else {
        toast({ title: "Already running", description: "Wait for the current job to finish.", variant: "destructive" });
      }
      statusQ.refetch();
    },
    onError: (err) => {
      toast({ title: "Failed to start ingest", description: String(err), variant: "destructive" });
    },
  });

  const data = statusQ.data;
  const job = data?.job;
  const isRunning = job?.status === "running";

  const totalSourceSignals = data?.bySource.reduce((s, r) => s + r.count, 0) ?? 0;
  const topStatesBySignals = data?.byState.slice(0, 15) ?? [];

  return (
    <div className="space-y-4">
      {/* Trigger card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" /> National Data Ingest
          </CardTitle>
          <CardDescription>
            Run all 17 ingestors (NPPES, CMS, FDA, HCRIS, SAM.gov, CON filings, and more) across
            the {allStates ? "all 50 US states + DC" : "top-20 states by facility count"}.
            Runs in the background — this page will poll for progress.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <Button
              disabled={isRunning || triggerMut.isPending}
              onClick={() => triggerMut.mutate({ allStates })}
              className="flex items-center gap-2"
            >
              {(isRunning || triggerMut.isPending)
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Play className="h-4 w-4" />}
              {isRunning ? "Ingest Running…" : "Run National Ingest"}
            </Button>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={allStates}
                onChange={(e) => setAllStates(e.target.checked)}
                className="accent-primary"
              />
              Include all 50 states
            </label>
            <Button variant="ghost" size="sm" onClick={() => statusQ.refetch()} className="ml-auto">
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
          </div>

          {/* Job status */}
          {job && job.status !== "idle" && (
            <div className="border rounded-md p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Last job</span>
                {jobStatusBadge(job.status)}
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div>
                  <span className="text-muted-foreground">Started</span>
                  <div className="font-mono text-xs">{new Date(job.startedAt).toLocaleTimeString()}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Signals</span>
                  <div className="font-bold text-primary">+{job.signalsInserted.toLocaleString()}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Facilities</span>
                  <div className="font-bold">{job.facilitiesScanned.toLocaleString()}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Errors</span>
                  <div className={job.errors > 0 ? "text-destructive font-bold" : ""}>{job.errors}</div>
                </div>
              </div>
              {isRunning && job.currentSource && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Currently running: <span className="font-mono">{job.currentSource}</span>
                  {" — "}completed: {job.completedSources.join(", ") || "—"}
                </div>
              )}
              {job.status === "done" && job.finishedAt && (
                <div className="text-xs text-muted-foreground">
                  Finished at {new Date(job.finishedAt).toLocaleTimeString()}{" "}
                  ({Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s)
                  — sources: {job.completedSources.join(", ")}
                </div>
              )}
              {job.status === "error" && job.errorMessage && (
                <Alert variant="destructive" className="mt-2 py-2">
                  <AlertDescription className="text-xs font-mono">{job.errorMessage}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Signal coverage by source */}
      {data && data.bySource.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signal Coverage by Source</CardTitle>
            <CardDescription>
              {totalSourceSignals.toLocaleString()} active signals across {data.bySource.length} sources
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {data.bySource.map((row) => {
                const pct = totalSourceSignals > 0 ? Math.round((row.count / totalSourceSignals) * 100) : 0;
                return (
                  <div key={row.source} className="flex items-center gap-3 py-1">
                    <span className="font-mono text-xs w-40 truncate text-muted-foreground">{row.source}</span>
                    <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                      <div className="bg-primary h-2 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-sm font-medium w-20 text-right">{row.count.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Signal coverage by state */}
      {data && topStatesBySignals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signal Coverage by State</CardTitle>
            <CardDescription>Top 15 states by total signals</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="pb-2 font-medium">State</th>
                    <th className="pb-2 font-medium text-right">Facilities</th>
                    <th className="pb-2 font-medium text-right">w/ Signals</th>
                    <th className="pb-2 font-medium text-right">Coverage</th>
                    <th className="pb-2 font-medium text-right">Total Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {topStatesBySignals.map((row) => {
                    const pct = row.totalFacilities > 0
                      ? Math.round((row.facilitiesWithSignals / row.totalFacilities) * 100)
                      : 0;
                    return (
                      <tr key={row.state} className="border-b last:border-0">
                        <td className="py-1.5 font-mono font-medium">{row.state}</td>
                        <td className="py-1.5 text-right text-muted-foreground">{row.totalFacilities.toLocaleString()}</td>
                        <td className="py-1.5 text-right">{row.facilitiesWithSignals.toLocaleString()}</td>
                        <td className="py-1.5 text-right">
                          <span className={pct >= 50 ? "text-green-600 font-medium" : pct >= 20 ? "text-amber-600" : "text-muted-foreground"}>
                            {pct}%
                          </span>
                        </td>
                        <td className="py-1.5 text-right font-medium text-primary">{row.totalSignals.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Nightly run history */}
      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run History</CardTitle>
            <CardDescription>
              {data.recentRuns && data.recentRuns.length > 0
                ? `Last ${data.recentRuns.length} completed ingest runs`
                : "Completed runs will appear here after the first nightly ingest"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentRuns && data.recentRuns.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-left">
                      <th className="pb-2 font-medium">Started</th>
                      <th className="pb-2 font-medium">Duration</th>
                      <th className="pb-2 font-medium text-center">Status</th>
                      <th className="pb-2 font-medium text-right">Signals</th>
                      <th className="pb-2 font-medium text-right">Facilities</th>
                      <th className="pb-2 font-medium text-right">Errors</th>
                      <th className="pb-2 font-medium text-right">States</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentRuns.map((run) => {
                      const startedDate = new Date(run.startedAt);
                      const durationSec = Math.round(run.durationMs / 1000);
                      const durationLabel =
                        durationSec >= 3600
                          ? `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m`
                          : durationSec >= 60
                          ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
                          : `${durationSec}s`;
                      return (
                        <tr key={run.id} className="border-b last:border-0" title={run.errorMessage ?? undefined}>
                          <td className="py-1.5 font-mono text-xs">
                            <div>{startedDate.toLocaleDateString()}</div>
                            <div className="text-muted-foreground">{startedDate.toLocaleTimeString()}</div>
                          </td>
                          <td className="py-1.5 text-muted-foreground">{durationLabel}</td>
                          <td className="py-1.5 text-center">
                            {run.status === "done"
                              ? <Badge className="bg-green-600 text-white text-xs">Done</Badge>
                              : <Badge variant="destructive" className="text-xs">Error</Badge>}
                          </td>
                          <td className="py-1.5 text-right font-medium text-primary">+{run.signalsInserted.toLocaleString()}</td>
                          <td className="py-1.5 text-right text-muted-foreground">{run.facilitiesScanned.toLocaleString()}</td>
                          <td className={`py-1.5 text-right ${run.errors > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                            {run.errors}
                          </td>
                          <td className="py-1.5 text-right text-muted-foreground">{Array.isArray(run.states) ? run.states.length : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">No runs recorded yet. Trigger a national ingest above to see history here.</p>
            )}
          </CardContent>
        </Card>
      )}

      {statusQ.isLoading && (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading ingest status…
        </div>
      )}
    </div>
  );
}

function EncryptionKeyPanel() {
  const { toast } = useToast();
  const statusQ = useAdminEncryptionKeyStatus();
  const logQ = useAdminEncryptionKeyRotationLog({ limit: 25 });
  const rotateMut = useAdminEncryptionKeyRotate();

  const status = statusQ.data;
  const needsRotation = (status?.needsRotationCount ?? 0) > 0;
  const previousConfigured = status?.previousKeyConfigured ?? false;

  const handleRotate = (dryRun: boolean) => {
    if (!dryRun && !confirm(
      "This will re-encrypt every CRM credential blob with the current primary key. Existing connections keep working throughout. Proceed?",
    )) return;
    rotateMut.mutate(
      { data: { dryRun } },
      {
        onSuccess: (res) => {
          toast({
            title: dryRun ? "Dry run complete" : "Rotation complete",
            description: `Re-encrypted ${res.reEncrypted}, already current ${res.alreadyCurrent}, failed ${res.failed}.`,
            variant: res.failed > 0 ? "destructive" : "default",
          });
          statusQ.refetch();
          logQ.refetch();
        },
        onError: (err) => {
          const e = err as unknown as { error?: string; message?: string };
          toast({
            title: "Rotation failed",
            description: e?.message || e?.error || "Unknown error",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" /> CRM Credential Encryption Key
          </CardTitle>
          <CardDescription>
            Sub-account CRM tokens are encrypted at rest with AES-256-GCM
            under the <code>CRM_ENCRYPTION_KEY</code> secret. Rotation
            re-encrypts every stored blob under a new primary key without
            interrupting in-flight syncs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>How to rotate safely (no downtime)</AlertTitle>
            <AlertDescription>
              <ol className="list-decimal pl-5 space-y-1 mt-2 text-sm">
                <li>
                  Generate a new 32-byte key:{" "}
                  <code>openssl rand -base64 32</code>
                </li>
                <li>
                  Set <code>CRM_ENCRYPTION_KEY_PREVIOUS</code> to the
                  current value of <code>CRM_ENCRYPTION_KEY</code>, then
                  set <code>CRM_ENCRYPTION_KEY</code> to the new key.
                  Redeploy. Existing blobs continue to decrypt via the
                  fallback while new writes use the new key.
                </li>
                <li>
                  Click <strong>Dry run</strong> below to confirm how many
                  rows will be touched, then click <strong>Run rotation</strong>.
                  This re-encrypts every <code>sub_accounts.crm_credentials</code>{" "}
                  blob with the new primary key and writes one audit log
                  entry per row.
                </li>
                <li>
                  When <strong>Needs rotation</strong> reaches 0, remove
                  the <code>CRM_ENCRYPTION_KEY_PREVIOUS</code> secret and
                  redeploy. The old key is no longer in use anywhere.
                </li>
                <li>
                  Legacy plaintext rows (if any) cannot be auto-rotated —
                  open each sub-account's credentials editor and re-save
                  to encrypt them.
                </li>
              </ol>
            </AlertDescription>
          </Alert>

          {statusQ.isLoading && <div className="text-sm text-muted-foreground">Loading status…</div>}
          {status && (
            <div className="grid gap-3 md:grid-cols-3">
              <Stat label="Primary key id" value={status.primaryKid} mono />
              <Stat
                label="Previous key id"
                value={status.previousKid ?? "— (not configured)"}
                mono
              />
              <Stat
                label="Needs rotation"
                value={`${status.needsRotationCount} / ${status.encryptedCount} encrypted`}
                emphasis={needsRotation ? "warn" : "ok"}
              />
              <Stat label="Total sub-accounts" value={String(status.totalSubAccounts)} />
              <Stat label="Plaintext (legacy)" value={String(status.plaintextCount)} emphasis={status.plaintextCount > 0 ? "warn" : "ok"} />
              <Stat
                label="Last rotation"
                value={status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "Never"}
              />
            </div>
          )}

          {previousConfigured && (
            <Alert>
              <Activity className="h-4 w-4" />
              <AlertTitle>Fallback key is active</AlertTitle>
              <AlertDescription>
                <code>CRM_ENCRYPTION_KEY_PREVIOUS</code> is configured and
                will be tried whenever the primary key fails to decrypt a
                blob. Remove it after rotation is complete.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => handleRotate(true)}
              disabled={rotateMut.isPending || !status}
              data-testid="button-key-rotate-dryrun"
            >
              <RefreshCw className="h-4 w-4 mr-2" /> Dry run
            </Button>
            <Button
              onClick={() => handleRotate(false)}
              disabled={rotateMut.isPending || !needsRotation}
              data-testid="button-key-rotate-run"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {rotateMut.isPending ? "Rotating…" : "Run rotation"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => { statusQ.refetch(); logQ.refetch(); }}
            >
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent rotation events</CardTitle>
          <CardDescription>
            One row per sub-account touched by a rotation run. Grouped by{" "}
            <code>runId</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!logQ.data || logQ.data.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4">
              No rotation events recorded yet.
            </div>
          ) : (
            <div className="text-xs border rounded-md divide-y max-h-96 overflow-auto">
              {logQ.data.map((ev) => (
                <div key={ev.id} className="p-2 flex flex-wrap gap-x-4 gap-y-1 items-center">
                  <span className="font-mono text-muted-foreground">
                    {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : ""}
                  </span>
                  <span
                    className={
                      ev.status === "failed"
                        ? "text-destructive font-bold"
                        : ev.status === "re_encrypted"
                          ? "text-green-600 font-bold"
                          : "text-muted-foreground"
                    }
                  >
                    {ev.status}
                  </span>
                  {ev.dryRun && <span className="bg-secondary px-1 rounded">dry-run</span>}
                  {ev.decryptedWithPrevious && <span className="bg-amber-100 dark:bg-amber-900 px-1 rounded">via previous key</span>}
                  <span className="font-mono text-muted-foreground">
                    {ev.fromKid ?? "—"} → {ev.toKid ?? "—"}
                  </span>
                  <span className="font-mono text-muted-foreground truncate">
                    sub: {ev.subAccountId ?? "—"}
                  </span>
                  {ev.errorMessage && (
                    <span className="text-destructive truncate">{ev.errorMessage}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: "ok" | "warn";
}) {
  const valueClass =
    emphasis === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : emphasis === "ok"
        ? "text-green-600 dark:text-green-400"
        : "";
  return (
    <div className="border rounded-md p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={`text-lg ${mono ? "font-mono" : ""} ${valueClass}`}>{value}</div>
    </div>
  );
}

function LinkAllFacilitiesCard() {
  const { toast } = useToast();
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ linked: number; skipped: number; errors: number } | null>(null);

  const handleLinkAll = async () => {
    setIsRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/facilities/link-all", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json() as { linked: number; skipped: number; errors: number };
      setResult(body);
      toast({
        title: "Facilities linked",
        description: `Linked: ${body.linked}, Skipped: ${body.skipped}, Errors: ${body.errors}`,
      });
    } catch (err) {
      toast({ title: "Link-all failed", description: String(err), variant: "destructive" });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Link All Facilities
        </CardTitle>
        <CardDescription>
          Run the automated facility-to-CON-filing linker across the entire database. Uses fuzzy name matching and NPI cross-referencing.
          This is idempotent — safe to run multiple times.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex-1">
          {result ? (
            <div className="flex items-center gap-6 text-sm">
              <div>
                <span className="font-bold text-green-600">{result.linked}</span>
                <span className="text-muted-foreground ml-1">linked</span>
              </div>
              <div>
                <span className="font-bold text-muted-foreground">{result.skipped}</span>
                <span className="text-muted-foreground ml-1">skipped</span>
              </div>
              {result.errors > 0 && (
                <div>
                  <span className="font-bold text-red-500">{result.errors}</span>
                  <span className="text-muted-foreground ml-1">errors</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Processes all unlinked CON filings and attempts to match them to existing facilities.
            </p>
          )}
        </div>
        <Button
          onClick={handleLinkAll}
          disabled={isRunning}
          data-testid="button-link-all-facilities"
        >
          {isRunning ? (
            <>
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Link2 className="h-4 w-4 mr-2" /> Link All Facilities
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  const { data: me, isLoading: loadingMe } = useGetMe();
  const { data: stats } = useAdminPlatformStats();
  const { data: accountsRes } = useAdminListAccounts();
  const { data: subAccountsRes } = useAdminListSubAccounts();
  const { data: sources, refetch: refetchSources } = useAdminListEnrichmentSources();
  const { data: validationStats } = useAdminValidationStats();
  const accounts = accountsRes ?? [];
  const subAccounts = subAccountsRes ?? [];
  const { toast } = useToast();

  const [credsTarget, setCredsTarget] = useState<SubAccount | null>(null);

  // Surface the result of an OAuth callback redirect (?crmConnected=1 or
  // ?crmConnectError=...) so the rep sees a toast and the URL is cleaned up.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get("crmConnected");
    const err = params.get("crmConnectError");
    const provider = params.get("provider");
    const subAccountId = params.get("subAccountId");
    if (ok || err) {
      if (ok) {
        toast({
          title: `${provider ? provider.toUpperCase() : "CRM"} connected`,
          description: subAccountId
            ? `Tokens stored encrypted for sub-account ${subAccountId.slice(0, 8)}…`
            : "Tokens stored encrypted at rest.",
        });
      } else {
        toast({
          title: "CRM connection failed",
          description: err ?? "Unknown error",
          variant: "destructive",
        });
      }
      params.delete("crmConnected");
      params.delete("crmConnectError");
      params.delete("provider");
      params.delete("subAccountId");
      const next =
        window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
      window.history.replaceState(null, "", next);
    }
    // toast is stable from useToast; safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approveSource = useAdminApproveEnrichmentSource();
  const setBudget = useAdminSetEnrichmentSourceBudget();

  if (loadingMe) return null;
  if (!me?.isPlatformAdmin) return <Redirect to="/dashboard" />;

  const handleApprove = (source: string) => {
    approveSource.mutate({ source, data: {} }, {
      onSuccess: () => {
        toast({ title: "Source Approved" });
        refetchSources();
      }
    });
  };

  const handleSaveBudget = (source: string, cents: number | null) => {
    setBudget.mutate(
      { source, data: { monthBudgetCents: cents } },
      {
        onSuccess: () => {
          toast({
            title: cents == null ? "Budget cap cleared" : "Monthly budget updated",
          });
          refetchSources();
        },
        onError: () => {
          toast({ title: "Failed to update budget", variant: "destructive" });
        },
      },
    );
  };

  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-destructive flex items-center gap-2">
          <ShieldAlert className="h-8 w-8" /> Platform Admin
        </h1>
        <p className="text-muted-foreground">Global settings, billing, and integration management.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Active Accounts</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.activeAccounts || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total Facilities</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.totalFacilities || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total Contacts</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.totalContacts || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Active Signals</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-primary">{stats?.activeSignals || 0}</div></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="sources" className="w-full">
        <TabsList>
          <TabsTrigger value="sources">Enrichment Sources</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="validators">Validators (30d)</TabsTrigger>
          <TabsTrigger value="sub-accounts">Sub-Account CRM Credentials</TabsTrigger>
          <TabsTrigger value="webhooks" data-testid="tab-webhooks">CRM Webhooks</TabsTrigger>
          <TabsTrigger value="encryption-key">Encryption Key</TabsTrigger>
          <TabsTrigger value="con-review" data-testid="tab-con-review">CON Review</TabsTrigger>
          <TabsTrigger value="ingest" data-testid="tab-ingest">National Ingest</TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Data Sources</CardTitle>
              <CardDescription>Manage third-party API integrations and monthly spend caps</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {sources && sources.length > 0 ? (
                  sources.map(src => {
                    const isActive = src.isFreeSource ? src.envEnabled : (src.envEnabled && src.envKeyPresent && src.approved);
                    const spend = src.monthSpendCents ?? 0;
                    const budget = src.monthBudgetCents ?? null;
                    const pctOfBudget =
                      budget == null
                        ? null
                        : budget > 0
                          ? (spend / budget) * 100
                          : spend > 0
                            ? 100
                            : 0;
                    const overBudget = pctOfBudget != null && pctOfBudget >= 100;
                    const nearBudget =
                      pctOfBudget != null && pctOfBudget >= 80 && pctOfBudget < 100;
                    return (
                      <div key={src.source} className="p-4 border rounded-md" data-testid={`row-source-${src.source}`}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-lg">{src.source}</span>
                              {isActive ? (
                                <span className="text-xs bg-green-500/10 text-green-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"><CheckCircle2 className="h-3 w-3"/> Active</span>
                              ) : (
                                <span className="text-xs bg-red-500/10 text-red-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"><XCircle className="h-3 w-3"/> Inactive</span>
                              )}
                              {src.autoPaused && (
                                <span
                                  className="text-xs bg-red-500/10 text-red-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"
                                  data-testid={`badge-auto-paused-${src.source}`}
                                  title="Skipped during enrichment until spend resets or the cap is raised"
                                >
                                  <AlertTriangle className="h-3 w-3" /> Auto-paused
                                </span>
                              )}
                              {src.isFreeSource && <span className="text-xs bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded font-medium">Free</span>}
                            </div>

                            <div className="flex flex-wrap gap-4 mt-2 text-sm">
                              <div className="flex items-center gap-1">
                                {src.envEnabled ? <CheckCircle2 className="h-4 w-4 text-green-500"/> : <XCircle className="h-4 w-4 text-red-500"/>}
                                <span className={src.envEnabled ? "text-foreground" : "text-muted-foreground"}>Env Enabled</span>
                              </div>
                              {!src.isFreeSource && (
                                <>
                                  <div className="flex items-center gap-1">
                                    {src.envKeyPresent ? <CheckCircle2 className="h-4 w-4 text-green-500"/> : <XCircle className="h-4 w-4 text-red-500"/>}
                                    <span className={src.envKeyPresent ? "text-foreground" : "text-muted-foreground"}>API Key</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {src.approved ? <CheckCircle2 className="h-4 w-4 text-green-500"/> : <XCircle className="h-4 w-4 text-red-500"/>}
                                    <span className={src.approved ? "text-foreground" : "text-muted-foreground"}>Approved</span>
                                  </div>
                                </>
                              )}
                            </div>

                            {!src.isFreeSource && (
                              <div className="mt-3 space-y-2">
                                <div className="flex items-center gap-3 text-sm">
                                  <span className="text-muted-foreground">Month-to-date:</span>
                                  <span
                                    className={`font-semibold ${overBudget ? "text-red-500" : nearBudget ? "text-amber-500" : "text-foreground"}`}
                                    data-testid={`text-spend-${src.source}`}
                                  >
                                    {formatUsd(spend)}
                                  </span>
                                  <span className="text-muted-foreground">/</span>
                                  <span data-testid={`text-budget-${src.source}`}>
                                    {budget == null ? (
                                      <span className="text-muted-foreground italic">no cap</span>
                                    ) : (
                                      formatUsd(budget)
                                    )}
                                  </span>
                                  {pctOfBudget != null && (
                                    <span
                                      className={`text-xs ${overBudget ? "text-red-500" : nearBudget ? "text-amber-500" : "text-muted-foreground"}`}
                                    >
                                      ({pctOfBudget.toFixed(0)}%)
                                    </span>
                                  )}
                                  {(nearBudget || overBudget) && (
                                    <span
                                      className={`text-xs px-2 py-0.5 rounded font-medium flex items-center gap-1 ${overBudget ? "bg-red-500/10 text-red-500" : "bg-amber-500/10 text-amber-500"}`}
                                      data-testid={`badge-budget-warning-${src.source}`}
                                    >
                                      <AlertTriangle className="h-3 w-3" />
                                      {overBudget ? "Over budget" : "Approaching cap"}
                                    </span>
                                  )}
                                </div>
                                {pctOfBudget != null && (
                                  <div className="h-1.5 w-full max-w-sm bg-secondary rounded overflow-hidden">
                                    <div
                                      className={`h-full ${overBudget ? "bg-red-500" : nearBudget ? "bg-amber-500" : "bg-primary"}`}
                                      style={{ width: `${Math.min(100, pctOfBudget)}%` }}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col items-end gap-2">
                            {!src.isFreeSource && !src.approved && (
                              <Button
                                onClick={() => handleApprove(src.source)}
                                disabled={approveSource.isPending}
                                data-testid={`button-approve-${src.source}`}
                              >
                                Approve Source
                              </Button>
                            )}
                            {!src.isFreeSource && (
                              <BudgetEditor
                                source={src.source}
                                initialCents={budget}
                                onSave={(c) => handleSaveBudget(src.source, c)}
                                isPending={setBudget.isPending}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="py-4 text-muted-foreground">No sources configured.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="validators" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Validator Outcomes (last 30 days)</CardTitle>
              <CardDescription>
                How each email validator has been performing — useful for comparing accuracy and spotting silent errors.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <table className="w-full text-sm" data-testid="table-validator-stats">
                  <thead>
                    <tr className="border-b bg-muted/50 text-muted-foreground">
                      <th className="h-10 px-4 text-left font-medium">Validator</th>
                      <th className="h-10 px-4 text-right font-medium">Verified</th>
                      <th className="h-10 px-4 text-right font-medium">Bounced</th>
                      <th className="h-10 px-4 text-right font-medium">Errors</th>
                      <th className="h-10 px-4 text-right font-medium">Other</th>
                      <th className="h-10 px-4 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validationStats && validationStats.length > 0 ? (
                      validationStats.map((row) => (
                        <tr key={row.source} className="border-b last:border-0" data-testid={`row-validator-${row.source}`}>
                          <td className="p-4 font-medium capitalize">{row.source}</td>
                          <td className="p-4 text-right text-green-500" data-testid={`text-validator-${row.source}-verified`}>{row.verified}</td>
                          <td className="p-4 text-right text-red-500" data-testid={`text-validator-${row.source}-bounced`}>{row.bounced}</td>
                          <td className="p-4 text-right text-amber-500" data-testid={`text-validator-${row.source}-error`}>{row.error}</td>
                          <td className="p-4 text-right text-muted-foreground">{row.other}</td>
                          <td className="p-4 text-right font-semibold">{row.total}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-muted-foreground">
                          No validator activity in the last 30 days.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="webhooks" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>CRM Webhook Setup</CardTitle>
              <CardDescription>
                Copy the per-CRM URL and signing secret into each sub-account's
                CRM. The status indicator shows whether the most recent inbound
                event verified successfully.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4" data-testid="list-webhook-configs">
                {!subAccounts || subAccounts.length === 0 ? (
                  <div className="py-4 text-muted-foreground">
                    No sub-accounts yet. Create one under the Accounts tab to
                    wire up a CRM webhook.
                  </div>
                ) : (
                  subAccounts.map((sa) => (
                    <WebhookConfigRow
                      key={sa.id}
                      subAccountId={sa.id}
                      subAccountName={sa.name}
                    />
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accounts" className="mt-4">
          <div className="space-y-4">
            <LinkAllFacilitiesCard />
            <Card>
               <CardHeader>
                 <CardTitle>Tenant Accounts</CardTitle>
               </CardHeader>
               <CardContent>
                 <div className="divide-y border rounded-md">
                   {accounts.map((acc) => (
                     <div key={acc.id} className="p-4 flex justify-between items-center">
                       <div>
                         <div className="font-bold">{acc.name}</div>
                         <div className="text-sm text-muted-foreground">{acc.planTier || 'Default'} Plan • {acc.subAccountCount || 0} Sub-accounts</div>
                       </div>
                       <div className="text-sm bg-secondary px-2 py-1 rounded">{acc.status}</div>
                     </div>
                   ))}
                 </div>
               </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="con-review" className="mt-4">
          <ConReviewQueue />
        </TabsContent>

        <TabsContent value="sub-accounts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Sub-Account CRM Credentials</CardTitle>
              <CardDescription>
                Set the access tokens used by the push pipeline. Credentials are
                encrypted at rest with AES-256-GCM and never returned to the
                browser in plaintext.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!subAccounts || subAccounts.length === 0 ? (
                <div className="py-4 text-muted-foreground">No sub-accounts found.</div>
              ) : (
                <div className="divide-y border rounded-md">
                  {subAccounts.map((sub) => {
                    const acct = accountById.get(sub.accountId);
                    return (
                      <div key={sub.id} className="p-4 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="font-bold flex items-center gap-2">
                            {sub.name}
                            <span className="text-xs uppercase bg-secondary px-2 py-0.5 rounded">
                              {sub.crmType ?? "no crm"}
                            </span>
                          </div>
                          <div className="text-sm text-muted-foreground truncate">
                            {acct?.name ?? sub.accountId}
                            {sub.repName ? ` • Rep: ${sub.repName}` : ""}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => setCredsTarget(sub)}
                          data-testid={`button-credentials-${sub.id}`}
                        >
                          <KeyRound className="h-4 w-4 mr-2" /> Credentials
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Activity className="h-3 w-3" />
                Use “Test connection” inside each editor to verify the token
                against the live CRM before relying on it for batches.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="encryption-key" className="mt-4">
          <EncryptionKeyPanel />
        </TabsContent>

        <TabsContent value="ingest" className="mt-4">
          <NationalIngestPanel />
        </TabsContent>
      </Tabs>

      {credsTarget && (
        <SubAccountCredentialsDialog
          subAccount={credsTarget}
          open={Boolean(credsTarget)}
          onOpenChange={(o) => !o && setCredsTarget(null)}
        />
      )}
    </div>
  );
}
