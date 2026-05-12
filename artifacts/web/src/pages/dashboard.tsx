import { useGetDashboardSummary, useGetRecentSignals, useGetTopFacilities } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Users, Target, Activity, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";

export default function DashboardPage() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary();
  const { data: signals, isLoading: loadingSignals } = useGetRecentSignals({ limit: 5 });
  const { data: facilities, isLoading: loadingFacilities } = useGetTopFacilities({ limit: 5 });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
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
