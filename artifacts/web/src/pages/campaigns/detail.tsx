import { useParams } from "wouter";
import { 
  useGetCampaign, 
  useListCampaignContacts, 
  useAddCampaignContacts, 
  useGenerateCampaignDrafts,
  useUpdateCampaign
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Target, Users, Play, Settings, Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function CampaignDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  
  const { data: campaign, isLoading } = useGetCampaign(id);
  const { data: contactsRes, isLoading: loadingContacts } = useListCampaignContacts(id);
  const contacts = contactsRes ?? [];

  const generateDrafts = useGenerateCampaignDrafts();

  const handleGenerateDrafts = () => {
    generateDrafts.mutate({ id }, {
      onSuccess: (res) => {
        toast({
          title: "Drafts generated",
          description: `Generated ${res.generated ?? 0} drafts (skipped ${res.skipped ?? 0}).`,
        });
      },
      onError: (err) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-24 w-full" /><Skeleton className="h-[400px] w-full" /></div>;
  }

  if (!campaign) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Target className="h-12 w-12 text-muted-foreground mb-4 opacity-20" />
        <h2 className="text-2xl font-bold">Campaign Not Found</h2>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">{campaign.name}</h1>
            <div className="bg-secondary text-secondary-foreground px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider">
              {campaign.status}
            </div>
          </div>
          <p className="text-muted-foreground">{campaign.description || "No description provided."}</p>
        </div>
        
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleGenerateDrafts} disabled={generateDrafts.isPending}>
            <Play className="mr-2 h-4 w-4" /> {generateDrafts.isPending ? "Generating..." : "Generate Drafts"}
          </Button>
          <Button variant="secondary">
            <Settings className="mr-2 h-4 w-4" /> Settings
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <div className="md:col-span-1 space-y-6">
          <Card>
             <CardHeader>
               <CardTitle className="text-sm">Enrolled Contacts</CardTitle>
             </CardHeader>
             <CardContent>
               <div className="text-4xl font-bold">{campaign.contactCount || 0}</div>
             </CardContent>
          </Card>
          <Card>
             <CardHeader>
               <CardTitle className="text-sm">Pending Drafts</CardTitle>
             </CardHeader>
             <CardContent>
               <div className="text-4xl font-bold text-primary">{campaign.draftsPending || 0}</div>
             </CardContent>
          </Card>
        </div>

        <div className="md:col-span-3">
          <Card className="h-full">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Campaign Contacts</CardTitle>
                <CardDescription>Targets enrolled in this campaign</CardDescription>
              </div>
              <Button size="sm">Add Contacts</Button>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-muted-foreground">
                      <th className="h-10 px-4 text-left font-medium">Contact</th>
                      <th className="h-10 px-4 text-left font-medium">Facility</th>
                      <th className="h-10 px-4 text-right font-medium">Score</th>
                      <th className="h-10 px-4 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingContacts ? (
                      <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
                    ) : contacts.length > 0 ? (
                      contacts.map((cc) => (
                        <tr key={cc.id} className="border-b last:border-0">
                          <td className="p-4 font-medium">
                            {cc.contact?.firstName} {cc.contact?.lastName}
                          </td>
                          <td className="p-4 text-muted-foreground">
                            {cc.facility?.name}
                          </td>
                          <td className="p-4 text-right">{cc.score ?? 0}</td>
                          <td className="p-4 text-right">{cc.status}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="h-32 text-center text-muted-foreground">
                          <Users className="h-8 w-8 mx-auto mb-2 opacity-20" />
                          <p>No contacts enrolled yet</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}