import { useState } from "react";
import { Link } from "wouter";
import {
  useListOpportunities,
  useRecordAction,
  useRegenerateOpportunities,
  type OpportunityListItem,
  type OpportunityStatus,
} from "@/hooks/use-opportunities";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Inbox,
  ChevronRight,
  Sparkles,
  ThumbsUp,
  ThumbsDown,
  Clock,
  Send,
  RefreshCw,
  Building2,
  MapPin,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STATUS_OPTIONS: { value: OpportunityStatus | "all"; label: string }[] = [
  { value: "all", label: "Inbox (live)" },
  { value: "detected", label: "Detected" },
  { value: "rep_reviewed", label: "Reviewed" },
  { value: "qualified", label: "Qualified" },
  { value: "bid_submitted", label: "Bid submitted" },
  { value: "won", label: "Won" },
];

function fmtMoneyRange(low: number | null, high: number | null): string {
  if (low == null || high == null) return "—";
  const f = (n: number) => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  };
  return `${f(low)}–${f(high)}`;
}

function scoreColor(score: number): string {
  if (score >= 0.7) return "text-red-600 bg-red-500/10";
  if (score >= 0.5) return "text-orange-600 bg-orange-500/10";
  if (score >= 0.35) return "text-amber-600 bg-amber-500/10";
  return "text-slate-600 bg-slate-500/10";
}

function ConfidenceDots({ score }: { score: number }) {
  const dots = score >= 0.8 ? 5 : score >= 0.6 ? 4 : score >= 0.4 ? 3 : score >= 0.2 ? 2 : 1;
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            i <= dots ? "bg-primary" : "bg-muted"
          }`}
        />
      ))}
    </span>
  );
}

function OpportunityCard({ opp }: { opp: OpportunityListItem }) {
  const { toast } = useToast();
  const record = useRecordAction(opp.id);
  const score = Number(opp.readinessScore ?? 0);

  function act(actionType: "pursue" | "skip" | "snooze") {
    record.mutate(
      { actionType, snoozeDays: actionType === "snooze" ? 14 : undefined },
      {
        onSuccess: () =>
          toast({
            title:
              actionType === "pursue"
                ? "Marked Qualified"
                : actionType === "skip"
                  ? "Skipped"
                  : "Snoozed 14 days",
          }),
        onError: (err) =>
          toast({ variant: "destructive", title: "Action failed", description: err.message }),
      },
    );
  }

  return (
    <Card className="hover:border-primary/40 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 mb-1">
              <span
                className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-sm font-bold tabular-nums ${scoreColor(score)}`}
                title="Composite readiness score"
              >
                {Math.round(score * 100)}
              </span>
              <Badge variant="outline" className="text-xs uppercase tracking-wider">
                {opp.modality}
              </Badge>
              {opp.verticalSlug ? (
                <Badge variant="outline" className="text-xs">{opp.verticalSlug.replace("_", " ")}</Badge>
              ) : null}
              <ConfidenceDots score={score} />
            </div>
            <Link
              href={`/facilities/${opp.facilityId}`}
              className="font-semibold text-base hover:underline truncate block"
            >
              {opp.facility.name}
            </Link>
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-1">
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {opp.facility.facilityType}
              </span>
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {[opp.facility.city, opp.facility.state].filter(Boolean).join(", ") || "—"}
              </span>
              {opp.facility.beds ? <span>· {opp.facility.beds} beds</span> : null}
            </div>
          </div>

          <div className="text-right shrink-0">
            <div className="text-xs text-muted-foreground">Est. value</div>
            <div className="font-semibold tabular-nums">
              {fmtMoneyRange(opp.estimatedDollarLow, opp.estimatedDollarHigh)}
            </div>
          </div>
        </div>

        {/* Score breakdown chips */}
        {opp.scoreBreakdown && Object.keys(opp.scoreBreakdown).length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {Object.entries(opp.scoreBreakdown).map(([k, v]) => (
              <span
                key={k}
                className="text-[10px] uppercase tracking-wider text-muted-foreground border border-border rounded-full px-2 py-0.5"
                title={k}
              >
                {k.replace("_pts", "")} +{Number(v).toFixed(1)}
              </span>
            ))}
          </div>
        ) : null}

        {/* Decision-maker triangle status */}
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span className={opp.championContactId ? "text-emerald-600" : "text-muted-foreground/50"}>
            {opp.championContactId ? "● " : "○ "}Champion
          </span>
          <span className={opp.economicBuyerContactId ? "text-emerald-600" : "text-muted-foreground/50"}>
            {opp.economicBuyerContactId ? "● " : "○ "}Economic buyer
          </span>
          <span className={opp.gatekeeperContactId ? "text-emerald-600" : "text-muted-foreground/50"}>
            {opp.gatekeeperContactId ? "● " : "○ "}Gatekeeper
          </span>
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-border">
          <div className="flex gap-1">
            <Button size="sm" onClick={() => act("pursue")} disabled={record.isPending}>
              <ThumbsUp className="h-3.5 w-3.5 mr-1" /> Pursue
            </Button>
            <Button size="sm" variant="outline" onClick={() => act("skip")} disabled={record.isPending}>
              <ThumbsDown className="h-3.5 w-3.5 mr-1" /> Skip
            </Button>
            <Button size="sm" variant="outline" onClick={() => act("snooze")} disabled={record.isPending}>
              <Clock className="h-3.5 w-3.5 mr-1" /> Snooze
            </Button>
          </div>
          <Link href={`/opportunities/${opp.id}`}>
            <Button size="sm" variant="ghost">
              Open <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OpportunityInboxPage() {
  const [statusFilter, setStatusFilter] = useState<OpportunityStatus | "all">("all");
  const list = useListOpportunities({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 60,
  });
  const regenerate = useRegenerateOpportunities();
  const { toast } = useToast();

  function handleRegenerate() {
    regenerate.mutate(undefined, {
      onSuccess: (r) =>
        toast({
          title: "Inbox regenerated",
          description: `Created ${r.opportunitiesCreated}, updated ${r.opportunitiesUpdated} across ${r.accountsProcessed} accounts.`,
        }),
      onError: (err) =>
        toast({ variant: "destructive", title: "Regenerate failed", description: err.message }),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Inbox className="h-6 w-6" /> Opportunity Inbox
          </h1>
          <p className="text-sm text-muted-foreground">
            Ranked, ready-to-bid capital equipment opportunities. Built from the trigger engine + decision-maker triangle + your saved territories.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={regenerate.isPending}>
            {regenerate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Regenerate
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setStatusFilter(opt.value)}
            className={
              "text-xs rounded-full border px-3 py-1.5 " +
              (statusFilter === opt.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted")
            }
          >
            {opt.label}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : list.error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{list.error.message}</CardContent>
        </Card>
      ) : (list.data?.data.length ?? 0) === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> No opportunities yet
            </CardTitle>
            <CardDescription>
              The generator runs nightly at 03:15. Hit Regenerate to build the inbox from current signals + saved territories.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>Make sure at least one territory is saved under <Link href="/territories" className="text-primary hover:underline">/territories</Link> with the states you cover.</li>
              <li>Confirm the medintel signal scorer, EOL matcher, and accreditation watcher have run at least once (their crons are 02:18 → 02:45).</li>
              <li>Restart the API and check the log for <code>opportunity generation complete</code>.</li>
            </ul>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="text-xs text-muted-foreground">
            {list.data?.total ?? 0} total · showing {list.data?.data.length ?? 0}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {list.data?.data.map((opp) => (
              <OpportunityCard key={opp.id} opp={opp} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
