import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListFacilities, useEnrichContact, customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Building2, Users, Mail, Phone, ShieldCheck, Activity, ShieldX, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

interface GlobalContact {
  id: string;
  facilityId: string;
  facilityName: string | null;
  facilityState: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  department: string | null;
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  buyingAuthorityScore: number | null;
}

interface ContactsResponse {
  contacts: GlobalContact[];
  total: number;
  limit: number;
  offset: number;
}

export default function ContactsPage() {
  const [selectedFacility, setSelectedFacility] = useState<string>("all");
  const { toast } = useToast();

  const { data: facilitiesRes, isLoading: loadingFacilities } = useListFacilities({ limit: 200 });
  const facilities = facilitiesRes?.data || [];

  const facilityParam = selectedFacility !== "all" ? `&facilityId=${selectedFacility}` : "";
  const { data: contactsRes, isLoading: loadingContacts, refetch } = useQuery<ContactsResponse>({
    queryKey: ["contacts-global", selectedFacility],
    queryFn: () => customFetch<ContactsResponse>(`/api/contacts?limit=200${facilityParam}`),
  });

  const contacts = contactsRes?.contacts ?? [];

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
        <p className="text-muted-foreground">Manage and enrich facility decision-makers across your tracked facilities.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div className="w-full sm:w-72">
          <Select value={selectedFacility} onValueChange={setSelectedFacility}>
            <SelectTrigger>
              <SelectValue placeholder="All Facilities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Facilities</SelectItem>
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
        {selectedFacility !== "all" && (
          <Button variant="outline" asChild>
            <Link href={`/facilities/${selectedFacility}`}>View Facility Profile</Link>
          </Button>
        )}
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>
            {selectedFacility === "all" ? "All Contacts" : "Facility Contacts"}
          </CardTitle>
          <CardDescription>
            {selectedFacility === "all"
              ? `Decision-makers across all tracked facilities${contacts.length > 0 ? ` — ${contacts.length} found` : ""}`
              : "People associated with the selected organization"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Name</th>
                  {selectedFacility === "all" && (
                    <th className="h-10 px-4 text-left font-medium hidden lg:table-cell">Facility</th>
                  )}
                  <th className="h-10 px-4 text-left font-medium hidden sm:table-cell">Title</th>
                  <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Contact Info</th>
                  <th className="h-10 px-4 text-right font-medium">Authority Score</th>
                  <th className="h-10 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingContacts ? (
                  Array(5).fill(0).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-4"><Skeleton className="h-5 w-32" /></td>
                      {selectedFacility === "all" && (
                        <td className="p-4 hidden lg:table-cell"><Skeleton className="h-5 w-32" /></td>
                      )}
                      <td className="p-4 hidden sm:table-cell"><Skeleton className="h-5 w-40" /></td>
                      <td className="p-4 hidden md:table-cell"><Skeleton className="h-5 w-48" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-8 w-20 ml-auto" /></td>
                    </tr>
                  ))
                ) : contacts.length > 0 ? (
                  contacts.map((contact) => (
                    <tr key={contact.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-4">
                        <div className="font-medium">{contact.firstName} {contact.lastName}</div>
                      </td>
                      {selectedFacility === "all" && (
                        <td className="p-4 hidden lg:table-cell">
                          <Link
                            href={`/facilities/${contact.facilityId}`}
                            className="text-sm text-primary hover:underline"
                          >
                            {contact.facilityName ?? "Unknown"}
                          </Link>
                          {contact.facilityState && (
                            <div className="text-xs text-muted-foreground">{contact.facilityState}</div>
                          )}
                        </td>
                      )}
                      <td className="p-4 hidden sm:table-cell">
                        <div>{contact.title || "Unknown Title"}</div>
                        <div className="text-xs text-muted-foreground">{contact.department}</div>
                      </td>
                      <td className="p-4 hidden md:table-cell">
                        <div className="space-y-1">
                          {contact.email ? (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Mail className="h-3 w-3" /> {contact.email}
                              {contact.emailStatus === "verified" && <ShieldCheck className="h-3 w-3 text-green-500" />}
                              {contact.emailStatus === "bounced" && <ShieldX className="h-3 w-3 text-red-500" />}
                            </div>
                          ) : (
                            <div className="text-muted-foreground text-xs italic">No email</div>
                          )}
                          {contact.phone && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Phone className="h-3 w-3" /> {contact.phone}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <div className="inline-flex items-center gap-1 font-bold text-primary">
                          <Activity className="h-3 w-3" />
                          {contact.buyingAuthorityScore ?? 0}
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
                    <td colSpan={selectedFacility === "all" ? 6 : 5} className="h-48 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center gap-3">
                        <Users className="h-8 w-8 mb-2 opacity-20" />
                        <p className="font-medium">
                          {selectedFacility === "all"
                            ? "No contacts found across your tracked facilities"
                            : "No contacts found for this facility"}
                        </p>
                        <p className="text-xs max-w-xs leading-relaxed text-center">
                          Contacts are enriched automatically via the NPPES registry and data waterfall.
                          Run the contact ingest pipeline from Admin to populate decision-makers.
                        </p>
                        <Button variant="outline" size="sm" asChild>
                          <Link href="/admin">Go to Admin — Run Ingest</Link>
                        </Button>
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
