import { useGetDashboardSummary, useGetRecentSignals, useGetTopFacilities, customFetch } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Users, Target, Activity, CheckCircle2, AlertTriangle, ArrowRight, MailCheck, MailX, Crosshair, Zap } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { cn } from "@/lib/utils";

type LeadTier = "A" | "B" | "C";

interface DashLeadSignal {
  type: string;
  confidence: number;
}

interface DashLead {
  facilityId: string;
  name: string;
  state: string | null;
  score: number;
  tier: LeadTier;
  recommendedAction: string;
  urgency: "high" | "medium" | "low";
  crossSourceMatches: string[];
  topSignals: DashLeadSignal[];
}

const SIGNAL_LABELS: Record<string, string> = {
  con_filed: "CON Filed",
  con_approved: "CON Approved",
  bond_issued: "Bond Issued",
  bond_issuance: "Bond Issued",
  rfp_posted: "RFP Posted",
  hcris_depreciation_spike: "Aging Equipment",
  equipment_age_7yr: "Equipment Age 7+",
  high_utilization: "High Utilization",
  grant_awarded: "Grant Awarded",
  clinical_trial: "Clinical Trial",
  sec_capex_flag: "EDGAR CapEx",
  system_signal_propagated: "System Signal",
};

interface LeadsResponse {
  leads: DashLead[];
  total: number;
}

function tierBadge(tier: LeadTier) {
  if (tier === "A") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (tier === "B") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-blue-500/15 text-blue-400 border-blue-500/30";
}

export default function DashboardPage() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({
    query: { refetchInterval: 30_000 },
  });
  const { data: signals, isLoading: loadingSignals } = useGetRecentSignals(
    { limit: 5 },
    { query: { refetchInterval: 30_000 } },
  );
  const { data: facilities, isLoading: loadingFacilities } = useGetTopFacilities(
    { limit: 5 },
    { query: { refetchInterval: 60_000 } },
  );

  const { data: leadsData, isLoading: loadingLeads } = useQuery<LeadsResponse>({
    queryKey: ["leads-dashboard"],
    queryFn: () => customFetch<LeadsResponse>("/api/leads?minScore=60&limit=5&tierFilter=A"),
    refetchInterval: 5 * 60 * 1000,
  });

  const topLeads = leadsData?.leads ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            Live
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/facilities">Browse Facilities</Link>
          </Button>
          <Button asChild>
            <Link href="/campaigns">Create Campaign</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Facilities</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loadingSummary ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{summary?.totalFacilities || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Active in database
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Verified Contacts</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loadingSummary ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{summary?.verifiedContacts || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Of {summary?.totalContacts || 0} total contacts
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-primary/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-primary">Active Signals</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            {loadingSummary ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold text-primary">{summary?.activeSignals || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Purchase intent detected
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Drafts</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loadingSummary ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">{summary?.pendingDrafts || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Awaiting review
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Today's Top Leads */}
      <Card className="bg-card border-primary/20">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Crosshair className="h-4 w-4 text-primary" />
              Today's Top Leads
            </CardTitle>
            <CardDescription>Highest-intent facilities ranked by purchase signals</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/leads">View All Leads <ArrowRight className="ml-1 h-3 w-3" /></Link>
          </Button>
        </CardHeader>
        <CardContent>
          {loadingLeads ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : topLeads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Crosshair className="h-8 w-8 mb-2 opacity-20" />
              <p className="text-sm">No leads yet — track facilities to generate leads</p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link href="/facilities">Browse Facilities</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {topLeads.map((lead) => (
                <div
                  key={lead.facilityId}
                  className={cn(
                    "flex items-center justify-between border-b border-border pb-2 last:border-0 last:pb-0 gap-3",
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Badge
                      variant="outline"
                      className={cn("text-xs font-bold px-1.5 py-0 shrink-0 border", lead.tier === "A" ? "bg-red-500/15 text-red-400 border-red-500/30" : lead.tier === "B" ? "bg-amber-500/15 text-amber-400 border-amber-500/30" : "bg-blue-500/15 text-blue-400 border-blue-500/30")}
                    >
                      {lead.tier}
                    </Badge>
                    <div className="min-w-0">
                      <Link
                        href={`/facilities/${lead.facilityId}`}
                        className="text-sm font-medium hover:underline hover:text-primary leading-tight line-clamp-1 block"
                      >
                        {lead.name}
                      </Link>
                      <p className="text-xs text-muted-foreground truncate">{lead.recommendedAction}</p>
                      {lead.topSignals?.[0] && (
                        <p className="text-xs text-primary/60 truncate">
                          {SIGNAL_LABELS[lead.topSignals[0].type] ?? lead.topSignals[0].type.replace(/_/g, " ")}
                          {" · "}{lead.topSignals[0].confidence}%
                        </p>
                      )}
                    </div>
                    {lead.crossSourceMatches.length > 0 && (
                      <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30 shrink-0 hidden sm:flex items-center gap-0.5">
                        <Zap className="h-2.5 w-2.5" />
                        {lead.crossSourceMatches.length}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn(
                      "text-lg font-bold tabular-nums",
                      lead.score >= 70 ? "text-red-400" : lead.score >= 50 ? "text-amber-400" : "text-blue-400",
                    )}>
                      {lead.score}
                    </span>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" asChild>
                      <Link href={`/facilities/${lead.facilityId}`}>View</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Outreach Engagement</CardTitle>
            <CardDescription>Reply and bounce rates over the last 30 days, fed back into facility scores</CardDescription>
          </div>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {loadingSummary ? (
            <div className="grid gap-4 md:grid-cols-4">
              {Array(4).fill(0).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Sent</div>
                <div className="text-2xl font-bold mt-1">{summary?.sentCount ?? 0}</div>
                <p className="text-xs text-muted-foreground mt-1">Synced to CRM</p>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <MailCheck className="h-3 w-3 text-green-500" /> Reply rate
                </div>
                <div className="text-2xl font-bold mt-1 text-green-500">
                  {(summary?.replyRate ?? 0).toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {summary?.repliedCount ?? 0} replies received
                </p>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Opens</div>
                <div className="text-2xl font-bold mt-1">{summary?.openedCount ?? 0}</div>
                <p className="text-xs text-muted-foreground mt-1">Trackable opens</p>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <MailX className="h-3 w-3 text-destructive" /> Bounce rate
                </div>
                <div className="text-2xl font-bold mt-1 text-destructive">
                  {(summary?.bounceRate ?? 0).toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {summary?.bouncedCount ?? 0} bounced / unsubscribed
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 bg-card">
          <CardHeader>
            <CardTitle>Signals by Type</CardTitle>
            <CardDescription>Distribution of recent purchase signals</CardDescription>
          </CardHeader>
          <CardContent className="pl-2">
            {loadingSummary ? (
              <div className="h-[300px] flex items-center justify-center">
                <Skeleton className="h-[250px] w-full" />
              </div>
            ) : summary?.signalsByType && summary.signalsByType.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={summary.signalsByType}>
                  <XAxis
                    dataKey="signalType"
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `${value}`}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--muted)' }}
                    contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)' }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[300px] flex flex-col items-center justify-center text-center text-muted-foreground">
                <Activity className="h-10 w-10 mb-4 opacity-20" />
                <p>No signal data available</p>
                <p className="text-sm">Connect a data source or add facilities to generate signals</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3 bg-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Signals</CardTitle>
              <CardDescription>Latest intelligence across the platform</CardDescription>
            </div>
            <Button variant="ghost" size="icon" asChild>
              <Link href="/signals"><ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {loadingSignals ? (
                Array(5).fill(0).map((_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </div>
                ))
              ) : signals && signals.length > 0 ? (
                signals.map(signal => (
                  <div key={signal.id} className="flex items-start gap-4">
                    <div className="mt-1 bg-primary/10 p-2 rounded-full text-primary">
                      <Activity className="h-4 w-4" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium leading-none">
                        {signal.facilityName || 'Unknown Facility'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {signal.signalType} • Score: {signal.confidence}%
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(signal.detectedAt || '').toLocaleDateString()}
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <p>No recent signals found</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Top Facilities</CardTitle>
            <CardDescription>Ranked by aggregate signal score</CardDescription>
          </div>
          <Button variant="ghost" size="icon" asChild>
            <Link href="/facilities"><ArrowRight className="h-4 w-4" /></Link>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {loadingFacilities ? (
               Array(3).fill(0).map((_, i) => (
                <div key={i} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0">
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-5 w-1/3" />
                    <Skeleton className="h-4 w-1/4" />
                  </div>
                  <Skeleton className="h-8 w-16 rounded-full" />
                </div>
              ))
            ) : facilities && facilities.length > 0 ? (
              facilities.map(facility => (
                <div key={facility.id} className="flex items-center justify-between border-b border-border pb-4 last:border-0 last:pb-0">
                  <div>
                    <Link href={`/facilities/${facility.id}`} className="text-base font-medium hover:underline">
                      {facility.name}
                    </Link>
                    <div className="text-sm text-muted-foreground flex gap-2 items-center mt-1">
                      <span>{facility.facilityType}</span>
                      <span>•</span>
                      <span>{facility.city}, {facility.state}</span>
                      <span>•</span>
                      <span>{facility.contactCount || 0} Contacts</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-lg font-bold text-primary">{facility.signalScore}</div>
                      <div className="text-xs text-muted-foreground">Score</div>
                    </div>
                    <Button variant="secondary" size="sm" asChild>
                      <Link href={`/facilities/${facility.id}`}>View</Link>
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <Building2 className="h-8 w-8 mb-2 opacity-20" />
                <p>No facilities available</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
