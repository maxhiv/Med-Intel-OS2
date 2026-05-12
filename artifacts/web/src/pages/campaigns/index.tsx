import { useState } from "react";
import { useListCampaigns, useCreateCampaign, useGetDashboardSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Target, Search, Plus, Calendar, Users, Activity } from "lucide-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function CampaignsPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { toast } = useToast();

  const { data: summary } = useGetDashboardSummary();
  const subAccountId = summary?.myCampaigns ? "default" : "default"; // Mock logic if subaccount needed

  const { data: campaignsRes, isLoading, refetch } = useListCampaigns();
  const campaigns = campaignsRes ?? [];

  const createCampaign = useCreateCampaign();

  const handleCreate = () => {
    if (!name) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    createCampaign.mutate({
      data: { name, description, subAccountId: "dummy-subaccount-id" } // we might need a real subaccount ID from me?
    }, {
      onSuccess: () => {
        toast({ title: "Campaign created" });
        setCreateDialogOpen(false);
        setName("");
        setDescription("");
        refetch();
      },
      onError: (err) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">Manage active outreach efforts and prospect targeting.</p>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> New Campaign
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Campaign</DialogTitle>
              <DialogDescription>Define a new target segment for outreach.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Q3 Imaging Centers" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createCampaign.isPending}>
                {createCampaign.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Campaigns</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{campaigns.filter((c) => c.status === 'active').length}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
             <CardTitle>All Campaigns</CardTitle>
             <div className="relative w-full sm:w-72">
               <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
               <Input placeholder="Search campaigns..." className="pl-9" />
             </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Name</th>
                  <th className="h-10 px-4 text-left font-medium hidden sm:table-cell">Status</th>
                  <th className="h-10 px-4 text-right font-medium hidden md:table-cell">Contacts</th>
                  <th className="h-10 px-4 text-right font-medium">Drafts Pending</th>
                  <th className="h-10 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array(3).fill(0).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-4"><Skeleton className="h-5 w-48" /></td>
                      <td className="p-4 hidden sm:table-cell"><Skeleton className="h-5 w-20" /></td>
                      <td className="p-4 text-right hidden md:table-cell"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-8 w-16 ml-auto" /></td>
                    </tr>
                  ))
                ) : campaigns.length > 0 ? (
                  campaigns.map((camp: typeof campaigns[number]) => (
                    <tr key={camp.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-4">
                        <Link href={`/campaigns/${camp.id}`} className="font-medium text-primary hover:underline">
                          {camp.name}
                        </Link>
                        {camp.description && <div className="text-xs text-muted-foreground mt-1">{camp.description}</div>}
                      </td>
                      <td className="p-4 hidden sm:table-cell">
                        <div className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-secondary text-secondary-foreground">
                          {camp.status}
                        </div>
                      </td>
                      <td className="p-4 text-right hidden md:table-cell">
                        <span className="text-muted-foreground">{camp.contactCount || 0}</span>
                      </td>
                      <td className="p-4 text-right">
                        <span className="font-medium">{camp.draftsPending || 0}</span>
                      </td>
                      <td className="p-4 text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/campaigns/${camp.id}`}>Manage</Link>
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="h-48 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Target className="h-8 w-8 mb-2 opacity-20" />
                        <p>No campaigns found</p>
                        <p className="text-xs mt-1">Create a campaign to start targeting facilities.</p>
                      </div>
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