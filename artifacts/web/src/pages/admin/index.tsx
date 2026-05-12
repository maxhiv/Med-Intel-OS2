import { useGetMe, useAdminPlatformStats, useAdminListAccounts, useAdminListEnrichmentSources, useAdminApproveEnrichmentSource } from "@workspace/api-client-react";
import { Redirect } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ShieldAlert, Activity, CheckCircle2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AdminPage() {
  const { data: me, isLoading: loadingMe } = useGetMe();
  const { data: stats } = useAdminPlatformStats();
  const { data: accountsRes } = useAdminListAccounts();
  const { data: sources, refetch: refetchSources } = useAdminListEnrichmentSources();
  const accounts = accountsRes?.data || [];
  const { toast } = useToast();
  
  const approveSource = useAdminApproveEnrichmentSource();

  if (loadingMe) return null;
  if (!me?.isPlatformAdmin) return <Redirect to="/dashboard" />;

  const handleApprove = (source: string) => {
    approveSource.mutate({ source, data: {} }, {
      onSuccess: () => {
        toast({ title: "Source Approved" });
        refetchSources();
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-destructive flex items-center gap-2">
          <ShieldAlert className="h-8 w-8" /> Platform Admin
        </h1>
        <p className="text-muted-foreground">Global settings, billing, and integration management.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Active Accounts</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.activeAccounts || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total Facilities</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.totalFacilities || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total Contacts</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{stats?.totalContacts || 0}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Active Signals</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-primary">{stats?.activeSignals || 0}</div></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="sources" className="w-full">
        <TabsList>
          <TabsTrigger value="sources">Enrichment Sources</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
        </TabsList>
        
        <TabsContent value="sources" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Data Sources</CardTitle>
              <CardDescription>Manage third-party API integrations for contact enrichment</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {sources && sources.length > 0 ? (
                  sources.map(src => {
                    const isActive = src.isFreeSource ? src.envEnabled : (src.envEnabled && src.envKeyPresent && src.approved);
                    return (
                      <div key={src.source} className="p-4 border rounded-md flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-lg">{src.source}</span>
                            {isActive ? (
                              <span className="text-xs bg-green-500/10 text-green-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"><CheckCircle2 className="h-3 w-3"/> Active</span>
                            ) : (
                              <span className="text-xs bg-red-500/10 text-red-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"><XCircle className="h-3 w-3"/> Inactive</span>
                            )}
                            {src.isFreeSource && <span className="text-xs bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded font-medium">Free</span>}
                          </div>
                          
                          <div className="flex gap-4 mt-2 text-sm">
                            <div className="flex items-center gap-1">
                              {src.envEnabled ? <CheckCircle2 className="h-4 w-4 text-green-500"/> : <XCircle className="h-4 w-4 text-red-500"/>} 
                              <span className={src.envEnabled ? "text-foreground" : "text-muted-foreground"}>Env Enabled</span>
                            </div>
                            {!src.isFreeSource && (
                              <>
                                <div className="flex items-center gap-1">
                                  {src.envKeyPresent ? <CheckCircle2 className="h-4 w-4 text-green-500"/> : <XCircle className="h-4 w-4 text-red-500"/>} 
                                  <span className={src.envKeyPresent ? "text-foreground" : "text-muted-foreground"}>API Key</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  {src.approved ? <CheckCircle2 className="h-4 w-4 text-green-500"/> : <XCircle className="h-4 w-4 text-red-500"/>} 
                                  <span className={src.approved ? "text-foreground" : "text-muted-foreground"}>Approved</span>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                        
                        {!src.isFreeSource && !src.approved && (
                          <Button 
                            onClick={() => handleApprove(src.source)}
                            disabled={approveSource.isPending}
                          >
                            Approve Source
                          </Button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="py-4 text-muted-foreground">No sources configured.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accounts" className="mt-4">
          <Card>
             <CardHeader>
               <CardTitle>Tenant Accounts</CardTitle>
             </CardHeader>
             <CardContent>
               <div className="divide-y border rounded-md">
                 {accounts.map(acc => (
                   <div key={acc.id} className="p-4 flex justify-between items-center">
                     <div>
                       <div className="font-bold">{acc.name}</div>
                       <div className="text-sm text-muted-foreground">{acc.planTier || 'Default'} Plan • {acc.subAccountCount || 0} Sub-accounts</div>
                     </div>
                     <div className="text-sm bg-secondary px-2 py-1 rounded">{acc.status}</div>
                   </div>
                 ))}
               </div>
             </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}