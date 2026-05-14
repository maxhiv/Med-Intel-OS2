import { useState } from "react";
import {
  useListSequences,
  useCreateSequence,
  useGetSequence,
  useAddSequenceStep,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Layers, Plus, Mail, Linkedin, Phone, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  email: <Mail className="h-3.5 w-3.5" />,
  linkedin: <Linkedin className="h-3.5 w-3.5" />,
  phone: <Phone className="h-3.5 w-3.5" />,
};

function StepEditor({ sequenceId, onClose }: { sequenceId: string; onClose: () => void }) {
  const { toast } = useToast();
  const { data: seq, isLoading, refetch } = useGetSequence(sequenceId);
  const addStep = useAddSequenceStep();

  const [stepChannel, setStepChannel] = useState("email");
  const [delayDays, setDelayDays] = useState("0");
  const [subjectLine, setSubjectLine] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [addingStep, setAddingStep] = useState(false);

  const steps = seq?.steps ?? [];

  const handleAddStep = () => {
    const nextStepNum = steps.length + 1;
    addStep.mutate(
      {
        id: sequenceId,
        data: {
          stepNum: nextStepNum,
          channel: stepChannel,
          delayDays: Number(delayDays) || 0,
          subjectLine: subjectLine.trim() || undefined,
          bodyTemplate: bodyTemplate.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          toast({ title: `Step ${nextStepNum} added` });
          setAddingStep(false);
          setSubjectLine("");
          setBodyTemplate("");
          setDelayDays("0");
          refetch();
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{seq?.name ?? "Sequence"}</DialogTitle>
        <DialogDescription>
          {seq?.description || "Edit steps for this outreach sequence."}
        </DialogDescription>
      </DialogHeader>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-3 py-2">
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No steps yet — add the first step below.
            </p>
          ) : (
            steps.map((step, i) => (
              <div
                key={step.id}
                className="flex items-start gap-3 p-3 border rounded-md bg-muted/30"
              >
                <div className="flex items-center justify-center h-7 w-7 rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0 mt-0.5">
                  {step.stepNum}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {CHANNEL_ICONS[step.channel ?? "email"]}
                    <span className="capitalize">{step.channel ?? "email"}</span>
                    {step.delayDays != null && step.delayDays > 0 && (
                      <span className="text-xs text-muted-foreground">
                        · +{step.delayDays}d delay
                      </span>
                    )}
                  </div>
                  {step.subjectLine && (
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      Subject: {step.subjectLine}
                    </div>
                  )}
                  {step.bodyTemplate && (
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2 whitespace-pre-line">
                      {step.bodyTemplate}
                    </div>
                  )}
                </div>
                {i < steps.length - 1 && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
                )}
              </div>
            ))
          )}

          {/* Add step form */}
          {addingStep ? (
            <div className="border rounded-md p-4 space-y-3 bg-card">
              <div className="text-sm font-semibold">Step {steps.length + 1}</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Channel</Label>
                  <Select value={stepChannel} onValueChange={setStepChannel}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="linkedin">LinkedIn</SelectItem>
                      <SelectItem value="phone">Phone</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Delay (days after previous step)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={delayDays}
                    onChange={(e) => setDelayDays(e.target.value)}
                  />
                </div>
              </div>
              {stepChannel === "email" && (
                <div className="space-y-1">
                  <Label>Subject Line</Label>
                  <Input
                    placeholder="e.g. Thinking about your imaging fleet..."
                    value={subjectLine}
                    onChange={(e) => setSubjectLine(e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label>Body / Script Template</Label>
                <Textarea
                  placeholder="Use {{firstName}}, {{facilityName}}, {{signalType}} as merge fields."
                  value={bodyTemplate}
                  onChange={(e) => setBodyTemplate(e.target.value)}
                  rows={5}
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleAddStep} disabled={addStep.isPending}>
                  {addStep.isPending ? "Adding..." : "Add Step"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddingStep(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setAddingStep(true)}
            >
              <Plus className="h-4 w-4 mr-2" /> Add Step
            </Button>
          )}
        </div>
      )}

      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  );
}

export default function SequencesPage() {
  const { data: sequencesRes, isLoading, refetch } = useListSequences();
  const sequences = sequencesRes ?? [];
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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
              <div className="p-6">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : sequences.length > 0 ? (
              sequences.map((seq) => (
                <div
                  key={seq.id}
                  className="p-6 flex items-center justify-between hover:bg-muted/30"
                >
                  <div className="space-y-1">
                    <div className="font-semibold text-lg">{seq.name}</div>
                    <div className="text-muted-foreground text-sm">{seq.description}</div>
                    <div className="text-xs font-medium text-primary mt-2">
                      {seq.totalSteps || 0} Steps • Channel:{" "}
                      {(seq.channel ?? "email").charAt(0).toUpperCase() +
                        (seq.channel ?? "email").slice(1)}
                    </div>
                  </div>
                  <Button variant="outline" onClick={() => setEditingId(seq.id)}>
                    Edit Steps
                  </Button>
                </div>
              ))
            ) : (
              <div className="p-12 text-center text-muted-foreground">
                <Layers className="h-10 w-10 mx-auto mb-4 opacity-20" />
                <p>No sequences defined yet</p>
                <p className="text-sm mt-1">
                  Create a sequence to build multi-step outreach playbooks.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Create sequence dialog */}
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
              <Label htmlFor="seq-channel">Default Channel</Label>
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

      {/* Step editor dialog */}
      {editingId && (
        <Dialog open={!!editingId} onOpenChange={(open) => { if (!open) setEditingId(null); }}>
          <StepEditor sequenceId={editingId} onClose={() => setEditingId(null)} />
        </Dialog>
      )}
    </div>
  );
}
