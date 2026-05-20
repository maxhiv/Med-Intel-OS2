import { Link, useParams } from "wouter";
import { useGetOpportunity, useRecordAction } from "@/hooks/use-opportunities";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  ThumbsUp,
  ThumbsDown,
  Clock,
  Send,
  CheckCircle2,
  XCircle,
  Mail,
  Phone,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function fmtMoney(value: number | null): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export default function OpportunityDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const detail = useGetOpportunity(id);
  const record = useRecordAction(id);

  function act(actionType: Parameters<typeof record.mutate>[0]["actionType"], extras: object = {}) {
    record.mutate(
      { actionType, ...extras } as Parameters<typeof record.mutate>[0],
      {
        onSuccess: () => toast({ title: `Marked ${actionType}` }),
        onError: (err) => toast({ variant: "destructive", title: "Action failed", description: err.message }),
      },
    );
  }

  if (detail.isLoading) return <Skeleton className="h-96 w-full" />;
  if (detail.error)
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">{detail.error.message}</CardContent>
      </Card>
    );
  if (!detail.data) return null;

  const opp = detail.data;
  const score = Number(opp.readinessScore ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <Link href="/opportunities" className="text-xs text-muted-foreground hover:underline">
            ← Inbox
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{opp.facility.name}</h1>
          <div className="text-sm text-muted-foreground flex gap-2 items-baseline flex-wrap">
            <Badge variant="outline" className="uppercase">{opp.modality}</Badge>
            {opp.verticalSlug ? <Badge variant="outline">{opp.verticalSlug.replace("_", " ")}</Badge> : null}
            <span>{opp.facility.city}, {opp.facility.state}</span>
            <span>{opp.facility.facilityType}</span>
            {opp.facility.beds ? <span>{opp.facility.beds} beds</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={() => act("pursue")}>
            <ThumbsUp className="h-4 w-4 mr-1" /> Pursue
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("snooze", { snoozeDays: 14 })}>
            <Clock className="h-4 w-4 mr-1" /> Snooze 14d
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("push_to_ghl")}>
            <Send className="h-4 w-4 mr-1" /> Push to GHL
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act("disqualify")}>
            <ThumbsDown className="h-4 w-4 mr-1" /> Skip
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act("won")}>
            <CheckCircle2 className="h-4 w-4 mr-1 text-emerald-600" /> Won
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act("lost")}>
            <XCircle className="h-4 w-4 mr-1 text-rose-600" /> Lost
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Readiness</div>
            <div className="text-3xl font-bold tabular-nums">{Math.round(score * 100)}</div>
            <div className="text-[10px] text-muted-foreground">out of 100</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Estimated value</div>
            <div className="text-xl font-semibold">
              {fmtMoney(opp.estimatedDollarLow)} – {fmtMoney(opp.estimatedDollarHigh)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Status</div>
            <Badge variant="outline" className="mt-1 capitalize">{opp.status.replace("_", " ")}</Badge>
            {opp.snoozedUntil ? (
              <div className="text-xs text-muted-foreground mt-1">Snoozed until {fmtDate(opp.snoozedUntil)}</div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Score breakdown</CardTitle>
          <CardDescription>How this opportunity scored 0–100, by component.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Object.entries(opp.scoreBreakdown ?? {}).map(([k, v]) => (
              <div key={k} className="rounded-md border border-border p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k.replace("_pts", "").replace("_", " ")}</div>
                <div className="text-lg font-semibold tabular-nums">+{Number(v).toFixed(1)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Decision-maker triangle</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(["champion", "economicBuyer", "gatekeeper"] as const).map((role) => {
              const c = opp.decisionMakers[role];
              const roleLabel = role === "economicBuyer" ? "Economic buyer" : role === "champion" ? "Clinical champion" : "Procurement gatekeeper";
              return (
                <div key={role} className="rounded-md border border-border p-3 min-h-[110px]">
                  <div className="text-xs text-muted-foreground">{roleLabel}</div>
                  {c ? (
                    <>
                      <div className="font-medium mt-1">
                        {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">{c.title ?? "—"}</div>
                      <div className="text-xs mt-2 flex flex-wrap gap-2">
                        {c.email ? (
                          <span className="inline-flex items-center gap-1">
                            <Mail className="h-3 w-3" /> {c.email}
                          </span>
                        ) : null}
                        {c.phone ? (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-3 w-3" /> {c.phone}
                          </span>
                        ) : null}
                      </div>
                      <Badge variant="outline" className="text-[10px] mt-2">
                        {c.verificationStatus ?? "unverified"}
                      </Badge>
                    </>
                  ) : (
                    <div className="text-xs text-muted-foreground mt-2 italic">No contact mapped yet.</div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active triggers</CardTitle>
          <CardDescription>The signals driving this opportunity.</CardDescription>
        </CardHeader>
        <CardContent>
          {opp.triggers.length === 0 ? (
            <div className="text-sm text-muted-foreground">No active triggers.</div>
          ) : (
            <ul className="divide-y divide-border">
              {opp.triggers.map((t) => (
                <li key={t.id} className="py-2 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-sm capitalize">{t.signalType.replace(/_/g, " ")}</div>
                    <div className="text-xs text-muted-foreground">{t.source} · {fmtDate(t.detectedAt)}</div>
                  </div>
                  <Badge variant="outline" className="text-xs">conf {t.confidence ?? "—"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {opp.actions.length === 0 ? (
            <div className="text-sm text-muted-foreground">No actions yet.</div>
          ) : (
            <ul className="divide-y divide-border">
              {opp.actions.map((a) => (
                <li key={a.id} className="py-2 text-sm">
                  <span className="font-medium capitalize">{a.actionType.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{fmtDate(a.performedAt)}</span>
                  {a.notes ? <div className="text-xs text-muted-foreground mt-1">{a.notes}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
