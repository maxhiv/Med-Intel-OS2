import { useState } from "react";
import {
  useListBatches,
  useRunBatches,
  useGetBatch,
  retryBatch,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Play, Clock, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

function statusBadge(status: string): string {
  switch (status) {
    case "complete":
      return "bg-green-500/10 text-green-500";
    case "failed":
      return "bg-red-500/10 text-red-500";
    case "partial":
      return "bg-orange-500/10 text-orange-500";
    case "running":
      return "bg-blue-500/10 text-blue-500";
    default:
      return "bg-yellow-500/10 text-yellow-600";
  }
}

export default function BatchesPage() {
  const { data: batchesRes, isLoading, refetch } = useListBatches();
  const batches = batchesRes ?? [];
  const { toast } = useToast();
  const runBatches = useRunBatches();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const detailQuery = useGetBatch(selectedId ?? "", {
    query: {
      enabled: Boolean(selectedId),
      queryKey: ["batch", selectedId ?? ""] as const,
    },
  });

  const handleRun = () => {
    runBatches.mutate(undefined, {
      onSuccess: (res) => {
        toast({
          title: "Batches Queued",
          description: `Pushed ${res.totalPushed ?? 0}, failed ${res.totalFailed ?? 0}.`,
        });
        refetch();
      },
      onError: (err) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    });
  };

  const handleRetry = async () => {
    if (!selectedId) return;
    setRetrying(true);
    try {
      const r = await retryBatch(selectedId);
      toast({
        title: "Retry complete",
        description: `Retried ${r.retried}, recovered ${r.pushed}, still failed ${r.failed}.`,
      });
      await Promise.all([refetch(), detailQuery.refetch()]);
    } catch (err) {
      toast({
        title: "Retry failed",
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setRetrying(false);
    }
  };

  const detail = detailQuery.data;
  const failedItems =
    detail?.items?.filter((i) => i.status === "failed") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sync Batches</h1>
          <p className="text-muted-foreground">
            Monitor daily CRM push synchronizations.
          </p>
        </div>
        <Button onClick={handleRun} disabled={runBatches.isPending}>
          <Play className="mr-2 h-4 w-4" />
          {runBatches.isPending ? "Running..." : "Force Run Now"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Batch History</CardTitle>
          <CardDescription>
            Recent synchronization jobs to the configured CRM. Click a row with
            failures to inspect and retry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Date</th>
                  <th className="h-10 px-4 text-left font-medium">CRM</th>
                  <th className="h-10 px-4 text-left font-medium">Status</th>
                  <th className="h-10 px-4 text-right font-medium">Target</th>
                  <th className="h-10 px-4 text-right font-medium">Pushed</th>
                  <th className="h-10 px-4 text-right font-medium">Failed</th>
                  <th className="h-10 px-4 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="p-4">
                      <Skeleton className="h-24 w-full" />
                    </td>
                  </tr>
                ) : batches.length > 0 ? (
                  batches.map((batch) => {
                    const failed = batch.failedCount ?? 0;
                    return (
                      <tr
                        key={batch.id}
                        className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                        onClick={() => setSelectedId(batch.id)}
                      >
                        <td className="p-4 font-medium">
                          {new Date(batch.batchDate).toLocaleDateString()}
                        </td>
                        <td className="p-4 text-muted-foreground uppercase text-xs">
                          {batch.crmType ?? "—"}
                        </td>
                        <td className="p-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusBadge(batch.status)}`}
                          >
                            {batch.status}
                          </span>
                        </td>
                        <td className="p-4 text-right text-muted-foreground">
                          {batch.targetCount || 0}
                        </td>
                        <td className="p-4 text-right font-medium text-green-500">
                          {batch.pushedCount || 0}
                        </td>
                        <td className="p-4 text-right font-medium text-red-500">
                          {failed}
                        </td>
                        <td className="p-4 text-right">
                          {failed > 0 ? (
                            <span className="inline-flex items-center text-xs text-red-500">
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              View
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Details
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td
                      colSpan={7}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <Clock className="h-8 w-8 mx-auto mb-2 opacity-20" />
                      <p>No batch runs recorded yet</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(selectedId)}
        onOpenChange={(o) => !o && setSelectedId(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Batch detail</DialogTitle>
            <DialogDescription>
              {detail?.batch
                ? `${detail.batch.crmType?.toUpperCase()} · ${new Date(detail.batch.batchDate).toLocaleDateString()} · ${detail.batch.status}`
                : "Loading…"}
            </DialogDescription>
          </DialogHeader>

          {detailQuery.isLoading || !detail ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground text-xs">Target</div>
                  <div className="font-semibold">
                    {detail.batch.targetCount ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Pushed</div>
                  <div className="font-semibold text-green-500">
                    {detail.batch.pushedCount ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Failed</div>
                  <div className="font-semibold text-red-500">
                    {detail.batch.failedCount ?? 0}
                  </div>
                </div>
              </div>

              {failedItems.length > 0 ? (
                <div className="rounded-md border border-border max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-muted-foreground sticky top-0">
                      <tr>
                        <th className="h-9 px-3 text-left font-medium">
                          Draft
                        </th>
                        <th className="h-9 px-3 text-left font-medium">
                          Error
                        </th>
                        <th className="h-9 px-3 text-right font-medium">
                          Attempts
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {failedItems.map((it) => (
                        <tr
                          key={it.id}
                          className="border-t border-border align-top"
                        >
                          <td className="px-3 py-2 font-mono text-[11px]">
                            {it.localId.slice(0, 8)}…
                          </td>
                          <td className="px-3 py-2 text-red-500">
                            {it.errorMessage ?? "Unknown error"}
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {(it.retryCount ?? 0) + 1}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex items-center text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
                  No failed items in this batch.
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {failedItems.length > 0 && (
              <Button onClick={handleRetry} disabled={retrying}>
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${retrying ? "animate-spin" : ""}`}
                />
                {retrying ? "Retrying…" : `Retry ${failedItems.length} failure${failedItems.length === 1 ? "" : "s"}`}
              </Button>
            )}
            <Button variant="outline" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
