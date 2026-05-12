import { useState } from "react";
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
  type SubAccount,
} from "@workspace/api-client-react";
import { Redirect } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldAlert, Activity, CheckCircle2, XCircle, AlertTriangle, KeyRound, RefreshCw, Lock } from "lucide-react";
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
