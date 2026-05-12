import { useState } from "react";
import { useListDrafts, useApproveDraft, useRejectDraft } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { FileText, Check, X, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function DraftsPage() {
  const [status, setStatus] = useState<"pending" | "approved" | "sent" | "skipped" | "rejected">("pending");
  const { data: draftsRes, isLoading, refetch } = useListDrafts({ status, limit: 50 });
  const drafts = draftsRes?.data || [];
  const { toast } = useToast();

  const approveDraft = useApproveDraft();
  const rejectDraft = useRejectDraft();

  const handleApprove = (id: string) => {
    approveDraft.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Draft Approved" });
        refetch();
      }
    });
  };

  const handleReject = (id: string) => {
    rejectDraft.mutate({ id, data: { reason: "Manual rejection" } }, {
      onSuccess: () => {
        toast({ title: "Draft Rejected" });
        refetch();
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Message Drafts</h1>
          <p className="text-muted-foreground">Review, edit, and approve personalized AI outreach.</p>
        </div>
        <Button variant="outline" onClick={() => refetch()}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <Tabs value={status} onValueChange={(v) => setStatus(v as any)} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="pending">Pending Review</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="sent">Sent</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
        </TabsList>

        <div className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : drafts.length > 0 ? (
            drafts.map(draft => (
              <Card key={draft.id}>
                <CardHeader className="pb-2 border-b bg-muted/20">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-lg">To: {draft.contact?.firstName} {draft.contact?.lastName}</CardTitle>
                      <div className="text-sm text-muted-foreground">{draft.facility?.name} • Channel: {draft.channel || 'Email'}</div>
                    </div>
                    {status === 'pending' && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => handleReject(draft.id)} disabled={rejectDraft.isPending}>
                          <X className="mr-1 h-4 w-4" /> Reject
                        </Button>
                        <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => handleApprove(draft.id)} disabled={approveDraft.isPending}>
                          <Check className="mr-1 h-4 w-4" /> Approve
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Subject</div>
                      <div className="font-medium border rounded px-3 py-2 bg-background">{draft.subject}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Body</div>
                      <div className="text-sm whitespace-pre-wrap border rounded px-3 py-2 bg-background font-mono leading-relaxed">{draft.body}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="py-24 text-center text-muted-foreground border rounded-lg bg-card border-dashed">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <h3 className="text-lg font-medium">No drafts found</h3>
              <p className="text-sm">There are no drafts in the {status} queue.</p>
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}