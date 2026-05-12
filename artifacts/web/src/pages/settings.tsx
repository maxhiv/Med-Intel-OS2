import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetConAlertSubscription,
  useUpsertConAlertSubscription,
  getGetConAlertSubscriptionQueryKey,
  type ConAlertSubscriptionInputStatusFilter,
} from "@workspace/api-client-react";
import { UserProfile } from "@clerk/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Building2, ShieldCheck, Bell, FileSignature } from "lucide-react";

const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

const ALL_MODALITIES = [
  "MRI","CT","PET","SPECT","LINAC","MAMMO","US","XRAY","CATH",
];

function ConAlertPreferencesCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sub, isLoading } = useGetConAlertSubscription();

  const [states, setStates] = useState<string[]>([]);
  const [modalities, setModalities] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] =
    useState<ConAlertSubscriptionInputStatusFilter>("any");
  const [isActive, setIsActive] = useState<boolean>(true);

  // Hydrate form state from server once the subscription loads. Keep refreshing
  // when it changes (e.g. after a PUT) so cached form state can't drift.
  useEffect(() => {
    if (sub) {
      setStates(sub.states ?? []);
      setModalities(sub.modalities ?? []);
      setStatusFilter(
        (sub.statusFilter as ConAlertSubscriptionInputStatusFilter) ?? "any",
      );
      setIsActive(sub.isActive ?? true);
    }
  }, [sub]);

  const { mutate: upsert, isPending } = useUpsertConAlertSubscription({
    mutation: {
      onSuccess: () => {
        toast({ title: "CON alert preferences saved" });
        queryClient.invalidateQueries({
          queryKey: getGetConAlertSubscriptionQueryKey(),
        });
      },
      onError: () => {
        toast({
          title: "Could not save preferences",
          description: "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const toggle = (
    list: string[],
    setter: (v: string[]) => void,
    value: string,
  ) => {
    setter(
      list.includes(value)
        ? list.filter((v) => v !== value)
        : [...list, value].sort(),
    );
  };

  const onSave = () => {
    upsert({
      data: { states, modalities, statusFilter, isActive },
    });
  };

  return (
    <Card className="md:col-span-2 bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" /> CON Filing Alerts
        </CardTitle>
        <CardDescription>
          Get a push notification the moment a Certificate-of-Need filing lands
          in a state and modality you cover. CON filings are the highest-intent
          purchase signal we track.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 bg-muted/20">
              <div className="space-y-0.5">
                <Label htmlFor="con-alerts-active" className="text-base">
                  Notify me when matching CON filings appear
                </Label>
                <p className="text-xs text-muted-foreground">
                  In-app notifications appear on the CON Filings page.
                </p>
              </div>
              <Switch
                id="con-alerts-active"
                checked={isActive}
                onCheckedChange={setIsActive}
                data-testid="switch-con-alerts-active"
              />
            </div>

            <div>
              <Label className="text-sm font-semibold flex items-center gap-2">
                <FileSignature className="h-3.5 w-3.5" /> States
              </Label>
              <p className="text-xs text-muted-foreground mb-3">
                Pick the states you cover. Leave empty to be alerted for every
                state.
              </p>
              <div className="grid grid-cols-6 sm:grid-cols-10 gap-2">
                {ALL_STATES.map((s) => {
                  const on = states.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggle(states, setStates, s)}
                      className={`text-xs font-mono rounded border px-2 py-1.5 transition-colors ${
                        on
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted/30 text-muted-foreground border-border hover:bg-muted"
                      }`}
                      data-testid={`btn-state-${s}`}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
              {states.length === 0 && (
                <div className="text-xs text-muted-foreground mt-2">
                  All states selected.
                </div>
              )}
            </div>

            <div>
              <Label className="text-sm font-semibold">Modalities</Label>
              <p className="text-xs text-muted-foreground mb-3">
                Limit alerts to specific equipment categories. Leave empty for
                any modality.
              </p>
              <div className="flex flex-wrap gap-3">
                {ALL_MODALITIES.map((m) => (
                  <label
                    key={m}
                    className="inline-flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={modalities.includes(m)}
                      onCheckedChange={() =>
                        toggle(modalities, setModalities, m)
                      }
                      data-testid={`checkbox-modality-${m}`}
                    />
                    <span className="font-mono text-xs">{m}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="max-w-xs">
              <Label className="text-sm font-semibold">
                Approval stage
              </Label>
              <p className="text-xs text-muted-foreground mb-3">
                Filter on application status as published by the regulator.
              </p>
              <Select
                value={statusFilter}
                onValueChange={(v) =>
                  setStatusFilter(v as ConAlertSubscriptionInputStatusFilter)
                }
              >
                <SelectTrigger data-testid="select-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any (filed or approved)</SelectItem>
                  <SelectItem value="approved">Approved only</SelectItem>
                  <SelectItem value="filed">Newly filed only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={onSave}
                disabled={isPending}
                data-testid="button-save-con-alerts"
              >
                {isPending ? "Saving…" : "Save preferences"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { data: me } = useGetMe();

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and profile preferences.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" /> Account Information
            </CardTitle>
            <CardDescription>Your current tenant association and role.</CardDescription>
          </CardHeader>
          <CardContent>
            {me?.account ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 bg-muted/30 p-4 rounded-lg border border-border">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Organization</div>
                    <div className="font-semibold text-lg">{me.account.name}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Plan Tier</div>
                    <div className="font-medium capitalize">{me.account.planTier || 'Standard'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Your Role</div>
                    <div className="font-medium capitalize flex items-center gap-2">
                       {me.user.role}
                       {me.isPlatformAdmin && <ShieldCheck className="h-4 w-4 text-primary" />}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Account Created</div>
                    <div className="font-medium">{new Date(me.account.createdAt || '').toLocaleDateString()}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-destructive/10 text-destructive p-4 rounded-lg border border-destructive/20">
                You are not currently assigned to any organization account. Please contact your platform administrator.
              </div>
            )}
          </CardContent>
        </Card>

        <ConAlertPreferencesCard />

        <div className="md:col-span-2 mt-4 flex justify-center">
           <UserProfile 
             appearance={{
               elements: {
                 rootBox: "w-full shadow-none",
                 card: "shadow-none border border-border bg-card w-full",
                 navbar: "hidden",
                 navbarMobileMenuRow: "hidden",
                 pageScrollBox: "p-6",
                 headerTitle: "text-2xl font-bold text-foreground",
                 headerSubtitle: "text-muted-foreground",
                 profileSectionTitle: "text-foreground font-semibold border-b border-border pb-2",
                 profileSectionTitleText: "text-foreground",
                 profileSectionContent: "pt-4",
                 profileSectionPrimaryButton: "text-primary hover:bg-muted",
               }
             }}
           />
        </div>
      </div>
    </div>
  );
}
