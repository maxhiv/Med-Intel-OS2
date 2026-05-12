import { useState } from "react";
import { useListFacilities, useCreateFacilityFromNpi } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Building2, Search, Plus, MapPin, Activity, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function FacilitiesPage() {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<string>("all");
  const [facilityType, setFacilityType] = useState<string>("all");
  const [npiInput, setNpiInput] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: facilitiesRes, isLoading, refetch } = useListFacilities({
    search: search || undefined,
    state: state !== "all" ? state : undefined,
    facilityType: facilityType !== "all" ? facilityType : undefined,
    limit: 50,
  });

  const createFacility = useCreateFacilityFromNpi();

  const handleCreateFacility = () => {
    if (npiInput.length !== 10) {
      toast({ title: "Invalid NPI", description: "NPI must be exactly 10 digits", variant: "destructive" });
      return;
    }
    createFacility.mutate({ data: { npi: npiInput } }, {
      onSuccess: () => {
        toast({ title: "Facility Created", description: "Facility successfully added from NPI registry." });
        setCreateDialogOpen(false);
        setNpiInput("");
        refetch();
      },
      onError: (err) => {
        toast({ title: "Error", description: err.message || "Failed to create facility", variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Facilities</h1>
          <p className="text-muted-foreground">Manage and track monitored healthcare facilities.</p>
        </div>
        
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> Add by NPI
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Facility</DialogTitle>
              <DialogDescription>
                Enter a 10-digit National Provider Identifier (NPI) to automatically pull facility details.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input 
                placeholder="e.g. 1234567890" 
                value={npiInput} 
                onChange={e => setNpiInput(e.target.value.replace(/\D/g, '').slice(0, 10))}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreateFacility} disabled={createFacility.isPending}>
                {createFacility.isPending ? "Adding..." : "Add Facility"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="bg-card">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row gap-4 items-center">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search facilities..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <Select value={state} onValueChange={setState}>
                <SelectTrigger className="w-full sm:w-[130px]">
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All States</SelectItem>
                  <SelectItem value="CA">California</SelectItem>
                  <SelectItem value="NY">New York</SelectItem>
                  <SelectItem value="TX">Texas</SelectItem>
                  <SelectItem value="FL">Texas</SelectItem>
                  <SelectItem value="IL">Illinois</SelectItem>
                </SelectContent>
              </Select>
              <Select value={facilityType} onValueChange={setFacilityType}>
                <SelectTrigger className="w-full sm:w-[160px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="Hospital">Hospital</SelectItem>
                  <SelectItem value="Ambulatory Surgery Center">ASC</SelectItem>
                  <SelectItem value="Dialysis Center">Dialysis</SelectItem>
                  <SelectItem value="Imaging Center">Imaging</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-muted-foreground">
                  <th className="h-10 px-4 text-left font-medium">Facility</th>
                  <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Type & Location</th>
                  <th className="h-10 px-4 text-right font-medium">Signal Score</th>
                  <th className="h-10 px-4 text-right font-medium">Contacts</th>
                  <th className="h-10 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array(5).fill(0).map((_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-4"><Skeleton className="h-5 w-48" /></td>
                      <td className="p-4 hidden md:table-cell"><Skeleton className="h-5 w-32" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-5 w-12 ml-auto" /></td>
                      <td className="p-4 text-right"><Skeleton className="h-8 w-16 ml-auto" /></td>
                    </tr>
                  ))
                ) : facilitiesRes?.data && facilitiesRes.data.length > 0 ? (
                  facilitiesRes.data.map((facility) => (
                    <tr key={facility.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-4">
                        <Link href={`/facilities/${facility.id}`} className="font-medium text-primary hover:underline">
                          {facility.name}
                        </Link>
                        <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" /> NPI: {facility.npi}
                        </div>
                      </td>
                      <td className="p-4 hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span>{facility.facilityType}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-muted-foreground text-xs">
                          <MapPin className="h-3 w-3" />
                          {facility.city}, {facility.state}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <div className="inline-flex items-center gap-1 font-bold text-primary bg-primary/10 px-2 py-1 rounded">
                          <Activity className="h-3 w-3" />
                          {facility.signalScore || 0}
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <span className="text-muted-foreground">{facility.contactCount || 0}</span>
                      </td>
                      <td className="p-4 text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/facilities/${facility.id}`}>View</Link>
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="h-48 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Building2 className="h-8 w-8 mb-2 opacity-20" />
                        <p>No facilities found</p>
                        <p className="text-xs mt-1">Try adjusting filters or add a new facility by NPI.</p>
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