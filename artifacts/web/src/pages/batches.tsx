import { useListBatches, useRunBatches } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

export default function BatchesPage() {
  const { data: batchesRes, isLoading, refetch } = useListBatches();
  const batches = batchesRes ?? [];
  const { toast } = useToast();
  
  const runBatches = useRunBatches();

  const handleRun = () => {
    runBatches.mutate(undefined, {
      onSuccess: (res) => {
        toast({ title: "Batches Queued", description: `Pushed ${res.totalPushed ?? 0} records to CRM.` });
        refetch();
      },
      onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" })
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sync Batches</h1>
          <p className="text-muted-foreground">Monitor daily CRM push synchronizations.</p>
        </div>
        <Button onClick={handleRun} disabled={runBatches.isPending}>
          <Play className="mr-2 h-4 w-4" /> {runBatches.isPending ? "Running..." : "Force Run Now"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Batch History</CardTitle>
          <CardDescription>Recent synchronization jobs to the configured CRM</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Date</th>
                  <th className="h-10 px-4 text-left font-medium">Status</th>
                  <th className="h-10 px-4 text-right font-medium">Target Count</th>
                  <th className="h-10 px-4 text-right font-medium">Pushed</th>
                  <th className="h-10 px-4 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={5} className="p-4"><Skeleton className="h-24 w-full" /></td></tr>
                ) : batches.length > 0 ? (
                  batches.map((batch) => (
                    <tr key={batch.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-4 font-medium">{new Date(batch.batchDate).toLocaleDateString()}</td>
                      <td className="p-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          batch.status === 'completed' ? 'bg-green-500/10 text-green-500' :
                          batch.status === 'failed' ? 'bg-red-500/10 text-red-500' :
                          'bg-yellow-500/10 text-yellow-600'
                        }`}>
                          {batch.status}
                        </span>
                      </td>
                      <td className="p-4 text-right text-muted-foreground">{batch.targetCount || 0}</td>
                      <td className="p-4 text-right font-medium text-green-500">{batch.pushedCount || 0}</td>
                      <td className="p-4 text-right font-medium text-red-500">{batch.failedCount || 0}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="h-32 text-center text-muted-foreground">
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
    </div>
  );
}