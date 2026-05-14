import { useState } from "react";
import { useParams } from "wouter";
import {
  useGetCampaign,
  useListCampaignContacts,
  useAddCampaignContacts,
  useGenerateCampaignDrafts,
  useUpdateCampaign,
  useGetFacilityContacts,
  useListFacilities,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Target, Users, Play, Settings } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function CampaignDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();

  const { data: campaign, isLoading, refetch } = useGetCampaign(id);
  const { data: contactsRes, isLoading: loadingContacts, refetch: refetchContacts } = useListCampaignContacts(id);
  const contacts = contactsRes ?? [];

  const generateDrafts = useGenerateCampaignDrafts();
  const addContacts = useAddCampaignContacts();
  const updateCampaign = useUpdateCampaign();

  // Add Contacts dialog
  const [addOpen, setAddOpen] = useState(false);
  const [selectedFacilityId, setSelectedFacilityId] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);

  const { data: facilitiesRes } = useListFacilities({ limit: 50 });
  const facilityList = facilitiesRes?.data ?? [];

  const { data: facilityContacts } = useGetFacilityContacts(selectedFacilityId, {
    query: { enabled: !!selectedFacilityId },
  });

  // Settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsName, setSettingsName] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsBatchSize, setSettingsBatchSize] = useState("");

  const handleOpenSettings = () => {
    if (campaign) {
      setSettingsName(campaign.name ?? "");
      setSettingsStatus(campaign.status ?? "draft");
      setSettingsBatchSize(String(campaign.batchSizeDaily ?? 10));
    }
    setSettingsOpen(true);
  };

  const handleSaveSettings = () => {
    updateCampaign.mutate(
      {
        id,
        data: {
          name: settingsName.trim() || undefined,
          status: settingsStatus || undefined,
          batchSizeDaily: Number(settingsBatchSize) || undefined,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Campaign updated" });
          setSettingsOpen(false);
          refetch();
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  const handleGenerateDrafts = () => {
    generateDrafts.mutate(
      { id },
      {
        onSuccess: (res) => {
          toast({
            title: "Drafts generated",
            description: `Generated ${res.generated ?? 0} drafts (skipped ${res.skipped ?? 0}).`,
          });
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  const toggleContact = (contactId: string) => {
    setSelectedContactIds((prev) =>
      prev.includes(contactId) ? prev.filter((c) => c !== contactId) : [...prev, contactId],
    );
  };

  const handleAddContacts = () => {
    if (selectedContactIds.length === 0) {
      toast({ title: "Select at least one contact", variant: "destructive" });
      return;
    }
    addContacts.mutate(
      { id, data: { contactIds: selectedContactIds } },
      {
        onSuccess: (res) => {
          toast({
            title: "Contacts added",
            description: `Added ${res.added ?? 0} (skipped ${res.skipped ?? 0} already enrolled).`,
          });
          setAddOpen(false);
          setSelectedContactIds([]);
          setSelectedFacilityId("");
          refetchContacts();
          refetch();
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
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
          <Button
            variant="outline"
            onClick={handleGenerateDrafts}
            disabled={generateDrafts.isPending}
          >
            <Play className="mr-2 h-4 w-4" />
            {generateDrafts.isPending ? "Generating..." : "Generate Drafts"}
          </Button>
          <Button variant="secondary" onClick={handleOpenSettings}>
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
              <Button size="sm" onClick={() => setAddOpen(true)}>
                Add Contacts
              </Button>
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
                      <tr>
                        <td colSpan={4} className="p-4 text-center text-muted-foreground">
                          Loading...
                        </td>
                      </tr>
                    ) : contacts.length > 0 ? (
                      contacts.map((cc) => (
                        <tr key={cc.id} className="border-b last:border-0">
                          <td className="p-4 font-medium">
                            {cc.contact?.firstName} {cc.contact?.lastName}
                          </td>
                          <td className="p-4 text-muted-foreground">{cc.facility?.name}</td>
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

      {/* Add Contacts Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Contacts</DialogTitle>
            <DialogDescription>Select a facility and choose contacts to enroll.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Facility</Label>
              <Select value={selectedFacilityId} onValueChange={(v) => { setSelectedFacilityId(v); setSelectedContactIds([]); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a facility..." />
                </SelectTrigger>
                <SelectContent>
                  {facilityList.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name} — {f.city}, {f.state}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedFacilityId && (
              <div className="space-y-1">
                <Label>Contacts</Label>
                <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
                  {!facilityContacts || facilityContacts.length === 0 ? (
                    <div className="p-4 text-sm text-muted-foreground text-center">
                      No contacts found for this facility.
                    </div>
                  ) : (
                    facilityContacts.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 cursor-pointer"
                        onClick={() => toggleContact(c.id)}
                      >
                        <Checkbox
                          checked={selectedContactIds.includes(c.id)}
                          onCheckedChange={() => toggleContact(c.id)}
                        />
                        <div className="text-sm">
                          <div className="font-medium">
                            {c.firstName} {c.lastName}
                          </div>
                          <div className="text-muted-foreground text-xs">{c.title}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {selectedContactIds.length > 0 && (
                  <p className="text-xs text-muted-foreground">{selectedContactIds.length} selected</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddOpen(false); setSelectedContactIds([]); setSelectedFacilityId(""); }}>
              Cancel
            </Button>
            <Button onClick={handleAddContacts} disabled={addContacts.isPending || selectedContactIds.length === 0}>
              {addContacts.isPending ? "Adding..." : `Add ${selectedContactIds.length > 0 ? selectedContactIds.length : ""} Contacts`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Campaign Settings</DialogTitle>
            <DialogDescription>Update name, status, and daily batch size.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="camp-name">Name</Label>
              <Input
                id="camp-name"
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="camp-status">Status</Label>
              <Select value={settingsStatus} onValueChange={setSettingsStatus}>
                <SelectTrigger id="camp-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="camp-batch">Daily Batch Size</Label>
              <Input
                id="camp-batch"
                type="number"
                min={1}
                max={500}
                value={settingsBatchSize}
                onChange={(e) => setSettingsBatchSize(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveSettings} disabled={updateCampaign.isPending}>
              {updateCampaign.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
