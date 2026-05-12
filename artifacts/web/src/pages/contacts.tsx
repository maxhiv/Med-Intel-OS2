import { useState } from "react";
import { useListFacilities, useGetFacilityContacts, useEnrichContact } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Building2, Users, Mail, Phone, ShieldCheck, Activity, ShieldX, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

export default function ContactsPage() {
  const [selectedFacility, setSelectedFacility] = useState<string>("");
  const { toast } = useToast();

  const { data: facilitiesRes, isLoading: loadingFacilities } = useListFacilities({ limit: 50 });
  const facilities = facilitiesRes?.data || [];
  
  // Default to first facility if none selected
  const activeFacilityId = selectedFacility || (facilities.length > 0 ? facilities[0].id : "");

  const { data: contacts, isLoading: loadingContacts, refetch } = useGetFacilityContacts(activeFacilityId, {
    query: { enabled: !!activeFacilityId, queryKey: [`/api/facilities/${activeFacilityId}/contacts`] }
  });

  const enrichContact = useEnrichContact();

  const handleEnrich = (contactId: string) => {
    enrichContact.mutate({ id: contactId, data: { dryRun: false } }, {
      onSuccess: () => {
        toast({ title: "Contact Enriched", description: "Successfully gathered more data on contact." });
        refetch();
      },
      onError: (err) => {
        toast({ title: "Enrichment Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Contacts</h1>
        <p className="text-muted-foreground">Manage and enrich facility decision-makers.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div className="w-full sm:w-72">
          <Select value={selectedFacility} onValueChange={setSelectedFacility}>
            <SelectTrigger>
              <SelectValue placeholder="Select Facility..." />
            </SelectTrigger>
            <SelectContent>
              {loadingFacilities ? (
                <SelectItem value="loading" disabled>Loading...</SelectItem>
              ) : facilities.length > 0 ? (
                facilities.map(f => (
                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                ))
              ) : (
                <SelectItem value="none" disabled>No facilities found</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        {activeFacilityId && (
          <Button variant="outline" asChild>
            <Link href={`/facilities/${activeFacilityId}`}>View Facility Profile</Link>
          </Button>
        )}
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Facility Contacts</CardTitle>
          <CardDescription>People associated with the selected organization</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Name</th>
                  <th className="h-10 px-4 text-left font-medium hidden sm:table-cell">Title</th>
                  <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Contact Info</th>
                  <th className="h-10 px-4 text-right font-medium">Authority Score</th>
                  <th className="h-10 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {!activeFacilityId ? (
                   <tr>
                     <td colSpan={5} className="h-48 text-center text-muted-foreground">
                       <Building2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
                       <p>Select a facility to view its contacts.</p>
                     </td>
                   </tr>
                ) : loadingContacts ? (
                  Array(5).fill(0).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-4"><Skeleton className="h-5 w-32" /></td>
                      <td className="p-4 hidden sm:table-cell"><Skeleton className="h-5 w-40" /></td>
                      <td className="p-4 hidden md:table-cell"><Skeleton className="h-5 w-48" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-8 w-20 ml-auto" /></td>
                    </tr>
                  ))
                ) : contacts && contacts.length > 0 ? (
                  contacts.map((contact) => (
                    <tr key={contact.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-4">
                        <div className="font-medium">{contact.firstName} {contact.lastName}</div>
                      </td>
                      <td className="p-4 hidden sm:table-cell">
                        <div>{contact.title || 'Unknown Title'}</div>
                        <div className="text-xs text-muted-foreground">{contact.department}</div>
                      </td>
                      <td className="p-4 hidden md:table-cell">
                        <div className="space-y-1">
                          {contact.email ? (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Mail className="h-3 w-3" /> {contact.email}
                              {contact.emailStatus === 'verified' && <ShieldCheck className="h-3 w-3 text-green-500" />}
                            </div>
                          ) : <div className="text-muted-foreground text-xs italic">No email</div>}
                          {contact.phone && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Phone className="h-3 w-3" /> {contact.phone}
                            </div>
                          )}
                          {contact.lastValidation ? (
                            <div
                              className="flex items-center gap-1.5 text-xs text-muted-foreground"
                              title={`Verified by ${contact.lastValidation.source} on ${new Date(contact.lastValidation.checkedAt).toLocaleString()}`}
                              data-testid={`text-validator-${contact.id}`}
                            >
                              {contact.lastValidation.result === 'verified' ? (
                                <ShieldCheck className="h-3 w-3 text-green-500" />
                              ) : contact.lastValidation.result === 'bounced' ? (
                                <ShieldX className="h-3 w-3 text-red-500" />
                              ) : contact.lastValidation.result === 'error' ? (
                                <AlertTriangle className="h-3 w-3 text-amber-500" />
                              ) : (
                                <ShieldCheck className="h-3 w-3 text-muted-foreground" />
                              )}
                              <span className="font-medium capitalize">{contact.lastValidation.source}</span>
                              <span>·</span>
                              <span className="capitalize">{contact.lastValidation.result}</span>
                              <span className="opacity-70">
                                · {new Date(contact.lastValidation.checkedAt).toLocaleDateString()}
                              </span>
                            </div>
                          ) : contact.email ? (
                            <div className="text-xs text-muted-foreground italic">Not yet validated</div>
                          ) : null}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <div className="inline-flex items-center gap-1 font-bold text-primary">
                          <Activity className="h-3 w-3" />
                          {contact.buyingAuthorityScore || 0}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <Button 
                          size="sm" 
                          variant="secondary" 
                          onClick={() => handleEnrich(contact.id)}
                          disabled={enrichContact.isPending}
                        >
                          Enrich
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="h-48 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Users className="h-8 w-8 mb-2 opacity-20" />
                        <p>No contacts found for this facility</p>
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