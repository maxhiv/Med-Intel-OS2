import { useParams } from "wouter";
import { useState } from "react";
import { 
  useGetFacility, 
  useUpdateFacility, 
  useSyncFacilityFromNpi 
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Building2, Activity, Users, Settings, Plus, Phone, Mail, MapPin } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function FacilityDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  
  const { data: facility, isLoading, refetch } = useGetFacility(id);
  const syncFacility = useSyncFacilityFromNpi();
  
  const handleSync = () => {
    syncFacility.mutate({ npi: facility?.npi || "" }, {
      onSuccess: () => {
        toast({ title: "Sync Complete", description: "Facility data updated from NPI registry." });
        refetch();
      },
      onError: (err) => {
        toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!facility) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Building2 className="h-12 w-12 text-muted-foreground mb-4 opacity-20" />
        <h2 className="text-2xl font-bold">Facility Not Found</h2>
        <p className="text-muted-foreground">The requested facility could not be found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">{facility.name}</h1>
            <div className="bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider">
              {facility.facilityType}
            </div>
          </div>
          <div className="text-muted-foreground flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1"><MapPin className="h-4 w-4" /> {facility.city}, {facility.state}</span>
            <span>NPI: {facility.npi}</span>
            {facility.beds && <span>{facility.beds} Beds</span>}
          </div>
        </div>
        
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncFacility.isPending}>
            {syncFacility.isPending ? "Syncing..." : "Sync from NPI"}
          </Button>
          <Button>Edit Facility</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="md:col-span-1 space-y-6">
          <Card className="bg-card">
            <CardHeader>
              <CardTitle className="text-sm">Signal Score</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold text-primary">{facility.signalScore || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Aggregate purchase intent</p>
            </CardContent>
          </Card>
          
          <Card className="bg-card">
            <CardHeader>
              <CardTitle className="text-sm">Organization Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div>
                <div className="text-muted-foreground mb-1">Ownership</div>
                <div className="font-medium">{facility.ownership || "Unknown"}</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">System Affiliation</div>
                <div className="font-medium">{facility.systemName || "Independent"}</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Teaching Hospital</div>
                <div className="font-medium">{facility.teachingHospital ? "Yes" : "No"}</div>
              </div>
            </CardContent>
          </Card>
        </div>
        
        <div className="md:col-span-3">
          <Tabs defaultValue="signals" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="signals">Signals</TabsTrigger>
              <TabsTrigger value="contacts">Contacts</TabsTrigger>
              <TabsTrigger value="equipment">Equipment</TabsTrigger>
            </TabsList>
            
            <TabsContent value="signals" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Recent Signals</CardTitle>
                  <CardDescription>Purchase intent and organizational changes</CardDescription>
                </CardHeader>
                <CardContent>
                  {facility.signals && facility.signals.length > 0 ? (
                    <div className="space-y-4">
                      {facility.signals.map((signal) => (
                        <div key={signal.id} className="flex items-start gap-4 pb-4 border-b last:border-0 last:pb-0">
                          <div className={`p-2 rounded-full ${signal.confidence && signal.confidence >= 80 ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                            <Activity className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="font-medium">{signal.signalType}</div>
                            <div className="text-sm text-muted-foreground mt-1">Source: {signal.source} {signal.signalValue ? `— ${signal.signalValue}` : ''}</div>
                            <div className="text-xs text-muted-foreground mt-1">{new Date(signal.detectedAt || '').toLocaleDateString()} • {signal.confidence}% Confidence</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      No signals detected for this facility.
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="contacts" className="mt-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>Key Contacts</CardTitle>
                    <CardDescription>Decision makers and technical staff</CardDescription>
                  </div>
                  <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Contact</Button>
                </CardHeader>
                <CardContent>
                  {facility.contacts && facility.contacts.length > 0 ? (
                    <div className="divide-y border border-border rounded-md">
                      {facility.contacts.map((contact) => (
                        <div key={contact.id} className="p-4 flex items-center justify-between hover:bg-muted/30">
                          <div className="flex items-center gap-4">
                            <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center font-semibold text-secondary-foreground">
                              {contact.firstName?.[0]}{contact.lastName?.[0]}
                            </div>
                            <div>
                              <div className="font-medium">{contact.firstName} {contact.lastName}</div>
                              <div className="text-sm text-muted-foreground">{contact.title} • {contact.department}</div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {contact.email && (
                              <Button variant="ghost" size="icon" title={contact.email}><Mail className="h-4 w-4" /></Button>
                            )}
                            {contact.phone && (
                              <Button variant="ghost" size="icon" title={contact.phone}><Phone className="h-4 w-4" /></Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      No contacts found for this facility.
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="equipment" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Installed Equipment Base</CardTitle>
                  <CardDescription>Known active capital equipment</CardDescription>
                </CardHeader>
                <CardContent>
                  {facility.equipment && facility.equipment.length > 0 ? (
                    <div className="divide-y border border-border rounded-md">
                      {facility.equipment.map((eq) => (
                        <div key={eq.id} className="p-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Settings className="h-5 w-5 text-muted-foreground" />
                            <div>
                              <div className="font-medium">{eq.modality} — {eq.manufacturer} {eq.model}</div>
                              <div className="text-sm text-muted-foreground">Installed: {eq.installYear}</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium">Est. Replacement</div>
                            <div className="text-sm text-primary font-bold">{eq.estReplacementYear || 'Unknown'}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      No equipment records found for this facility.
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}