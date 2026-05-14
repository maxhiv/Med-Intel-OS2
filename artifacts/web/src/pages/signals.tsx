import { useEffect, useRef, useState } from "react";
import { useGetRecentSignals } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetRecentSignalsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, AlertTriangle, ArrowUp, Building2, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function SignalsPage() {
  const queryClient = useQueryClient();
  const { data: signals, isLoading } = useGetRecentSignals(
    { limit: 100 },
    { query: { refetchInterval: 60_000 } },
  );

  const [newCount, setNewCount] = useState(0);
  const connectedRef = useRef(false);

  useEffect(() => {
    if (connectedRef.current) return;
    connectedRef.current = true;

    const es = new EventSource("/api/stream/signals");

    es.addEventListener("signals", (e) => {
      try {
        const incoming = JSON.parse(e.data) as unknown[];
        if (incoming.length > 0) {
          setNewCount((n) => n + incoming.length);
        }
      } catch {
        // ignore malformed event
      }
    });

    es.addEventListener("error", () => {
      // Browser will auto-reconnect on transient failures.
    });

    return () => {
      es.close();
      connectedRef.current = false;
    };
  }, []);

  const loadNew = () => {
    setNewCount(0);
    // Invalidate all recent-signals queries (signals page + dashboard widget).
    queryClient.invalidateQueries({ queryKey: getGetRecentSignalsQueryKey() });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Signals</h1>
            <p className="text-muted-foreground">Monitor platform-wide purchase intelligence.</p>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            Live
          </span>
        </div>
      </div>

      {newCount > 0 && (
        <button
          type="button"
          onClick={loadNew}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          <ArrowUp className="h-4 w-4" />
          {newCount} new {newCount === 1 ? "signal" : "signals"} — click to load
        </button>
      )}

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Signal Feed</CardTitle>
          <CardDescription>Latest intelligence events detected across all monitored facilities.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {isLoading ? (
              Array(8).fill(0).map((_, i) => (
                <div key={i} className="flex items-start gap-4 p-4 rounded-lg border border-border">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-5 w-1/3" />
                    <Skeleton className="h-4 w-1/4" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                </div>
              ))
            ) : signals && signals.length > 0 ? (
              signals.map(signal => (
                <div key={signal.id} className="flex items-start gap-4 p-4 rounded-lg border border-border hover:bg-muted/30 transition-colors group">
                  <div className={`mt-1 p-2 rounded-full flex-shrink-0 ${signal.confidence && signal.confidence >= 80 ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    <Activity className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-4 mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{signal.signalType}</span>
                        {signal.confidence && signal.confidence >= 80 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/20 text-primary">High Confidence</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(signal.detectedAt || '').toLocaleDateString()}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                      <Building2 className="h-4 w-4" />
                      <Link href={`/facilities/${signal.facilityId}`} className="hover:text-primary transition-colors hover:underline">
                        {signal.facilityName || 'Unknown Facility'}
                      </Link>
                      {signal.facilityState && <span>• {signal.facilityState}</span>}
                    </div>

                    <div className="text-sm border-l-2 border-border pl-3 text-muted-foreground">
                       Source: {signal.source}
                       {signal.signalValue && <span> — {signal.signalValue}</span>}
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="icon" asChild>
                       <Link href={`/facilities/${signal.facilityId}`}>
                         <ExternalLink className="h-4 w-4" />
                       </Link>
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground border rounded-lg border-dashed">
                <AlertTriangle className="h-10 w-10 mb-4 opacity-20" />
                <p className="text-lg font-medium">No signals detected</p>
                <p className="text-sm max-w-md mx-auto mt-2">Add more facilities or connect additional data sources to start gathering purchase intelligence.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
