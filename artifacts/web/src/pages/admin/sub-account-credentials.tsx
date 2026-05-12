import { useEffect, useMemo, useState } from "react";
import {
  useAdminGetSubAccountCredentials,
  useAdminUpdateSubAccountCredentials,
  useAdminTestSubAccountCredentials,
  useAdminClearSubAccountCredentials,
  useAdminListCrmCredentialSchemas,
  type SubAccount,
  type CrmCredentialField,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ShieldCheck, ShieldAlert, CheckCircle2, XCircle, KeyRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  subAccount: SubAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SUPPORTED_CRMS = ["ghl", "hubspot", "salesforce"] as const;

export function SubAccountCredentialsDialog({ subAccount, open, onOpenChange }: Props) {
  const { toast } = useToast();
  const [crmType, setCrmType] = useState<string>(subAccount.crmType ?? "ghl");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data: schemas } = useAdminListCrmCredentialSchemas();
  const credsQuery = useAdminGetSubAccountCredentials(subAccount.id, {
    query: {
      enabled: open,
      queryKey: ["adminGetSubAccountCredentials", subAccount.id],
    },
  });
  const updateMut = useAdminUpdateSubAccountCredentials();
  const testMut = useAdminTestSubAccountCredentials();
  const clearMut = useAdminClearSubAccountCredentials();

  // Reset state when re-opened or sub-account changes.
  useEffect(() => {
    if (open) {
      setCrmType(credsQuery.data?.crmType || subAccount.crmType || "ghl");
      setDraft({});
      setTestResult(null);
    }
  }, [open, subAccount.id, credsQuery.data?.crmType, subAccount.crmType]);

  const fieldsForType: CrmCredentialField[] = useMemo(() => {
    // Prefer the schema returned by the GET (matches stored crmType). When
    // the admin switches CRM type, fall back to the global schema list.
    if (
      credsQuery.data?.adapterAvailable &&
      credsQuery.data.crmType === crmType &&
      credsQuery.data.schema
    ) {
      return credsQuery.data.schema;
    }
    const match = schemas?.find((s) => s.crmType === crmType);
    return match?.fields ?? [];
  }, [credsQuery.data, schemas, crmType]);

  const stored = credsQuery.data?.fields ?? {};
  const sameType = (credsQuery.data?.crmType ?? null) === crmType;

  const handleSave = () => {
    setTestResult(null);
    updateMut.mutate(
      {
        id: subAccount.id,
        data: { crmType, credentials: draft },
      },
      {
        onSuccess: () => {
          toast({ title: "Credentials saved", description: "Encrypted at rest." });
          credsQuery.refetch();
          setDraft({});
        },
        onError: (err) => {
          const e = err as unknown as { error?: string; fields?: string[]; message?: string };
          toast({
            title: "Save failed",
            description: e?.fields ? `Missing: ${e.fields.join(", ")}` : e?.error || e?.message || "Unknown error",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleTest = () => {
    setTestResult(null);
    testMut.mutate(
      { id: subAccount.id },
      {
        onSuccess: (res) => setTestResult({ ok: res.ok, message: res.message }),
        onError: (err) => {
          const e = err as unknown as { ok?: boolean; message?: string };
          setTestResult({ ok: false, message: e?.message ?? "Connection test failed" });
        },
      },
    );
  };

  const handleClear = () => {
    if (!confirm("Wipe stored credentials for this sub-account?")) return;
    clearMut.mutate(
      { id: subAccount.id },
      {
        onSuccess: () => {
          toast({ title: "Credentials cleared" });
          credsQuery.refetch();
          setDraft({});
          setTestResult(null);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> CRM Credentials — {subAccount.name}
          </DialogTitle>
          <DialogDescription>
            Tokens are encrypted at rest with AES-256-GCM. Existing secrets are
            shown masked; leave a field blank to keep its current value.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              {credsQuery.data?.encrypted ? (
                <span className="inline-flex items-center gap-1 text-green-600">
                  <ShieldCheck className="h-4 w-4" /> Encrypted at rest
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <ShieldAlert className="h-4 w-4" /> Not yet encrypted
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>CRM Type</Label>
            <Select value={crmType} onValueChange={setCrmType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SUPPORTED_CRMS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {credsQuery.isLoading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : (
            <div className="space-y-3">
              {fieldsForType.map((f) => {
                const existing = sameType ? stored[f.key] : undefined;
                const placeholder = existing?.present
                  ? f.secret
                    ? `Stored: ${existing.value} (leave blank to keep)`
                    : (existing.value ?? "")
                  : (f.placeholder ?? "");
                return (
                  <div key={f.key} className="space-y-1">
                    <Label className="flex items-center gap-2">
                      {f.label}
                      {f.required && <span className="text-destructive">*</span>}
                      {f.secret && <span className="text-xs text-muted-foreground">(secret)</span>}
                    </Label>
                    <Input
                      type={f.secret ? "password" : "text"}
                      value={draft[f.key] ?? (sameType && !f.secret ? (existing?.value ?? "") : "")}
                      placeholder={placeholder}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      autoComplete="off"
                    />
                    {f.helpText && (
                      <p className="text-xs text-muted-foreground">{f.helpText}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {testResult && (
            <Alert variant={testResult.ok ? "default" : "destructive"}>
              {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              <AlertTitle>{testResult.ok ? "Connection succeeded" : "Connection failed"}</AlertTitle>
              <AlertDescription>{testResult.message}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="flex flex-wrap gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={handleClear}
            disabled={clearMut.isPending}
          >
            Clear credentials
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={testMut.isPending || credsQuery.isLoading}
            >
              {testMut.isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Test connection
            </Button>
            <Button onClick={handleSave} disabled={updateMut.isPending}>
              {updateMut.isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
