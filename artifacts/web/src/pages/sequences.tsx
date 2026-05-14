import { useState } from "react";
import { useListSequences, useCreateSequence } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Layers, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function SequencesPage() {
  const { data: sequencesRes, isLoading, refetch } = useListSequences();
  const sequences = sequencesRes ?? [];
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [channel, setChannel] = useState("email");

  const createSequence = useCreateSequence();

  const handleCreate = () => {
    if (!name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    createSequence.mutate(
      { data: { name: name.trim(), description: description.trim() || undefined, channel } },
      {
        onSuccess: () => {
          toast({ title: "Sequence created", description: `"${name}" is ready.` });
          setCreateOpen(false);
          setName("");
          setDescription("");
          setChannel("email");
          refetch();
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sequences</h1>
          <p className="text-muted-foreground">Manage multi-step outreach playbooks.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Sequence
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y border-t border-border">
            {isLoading ? (
              <div className="p-6"><Skeleton className="h-24 w-full" /></div>
            ) : sequences.length > 0 ? (
              sequences.map((seq) => (
                <div key={seq.id} className="p-6 flex items-center justify-between hover:bg-muted/30">
                  <div className="space-y-1">
                    <div className="font-semibold text-lg">{seq.name}</div>
                    <div className="text-muted-foreground text-sm">{seq.description}</div>
                    <div className="text-xs font-medium text-primary mt-2">
                      {seq.totalSteps || 0} Steps • Channel: {seq.channel || "Email"}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() =>
                      toast({
                        title: "Sequence steps",
                        description: "Step editing is managed via the Drafts page when a campaign runs this sequence.",
                      })
                    }
                  >
                    Edit
                  </Button>
                </div>
              ))
            ) : (
              <div className="p-12 text-center text-muted-foreground">
                <Layers className="h-10 w-10 mx-auto mb-4 opacity-20" />
                <p>No sequences defined</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Sequence</DialogTitle>
            <DialogDescription>Create a multi-step outreach playbook.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="seq-name">Name</Label>
              <Input
                id="seq-name"
                placeholder="e.g. MRI Replacement Outreach"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seq-desc">Description</Label>
              <Textarea
                id="seq-desc"
                placeholder="Describe what this sequence is for..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seq-channel">Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger id="seq-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="phone">Phone</SelectItem>
                  <SelectItem value="multi">Multi-channel</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createSequence.isPending}>
              {createSequence.isPending ? "Creating..." : "Create Sequence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
