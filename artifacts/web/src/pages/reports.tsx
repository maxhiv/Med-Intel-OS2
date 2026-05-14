import { useState } from "react";
import {
  useListReportTemplates,
  useListReportRuns,
  useCreateReportTemplate,
  useRunReport,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Plus, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export default function ReportsPage() {
  const { toast } = useToast();
  const { data: templatesRes, refetch: refetchTemplates } = useListReportTemplates();
  const templates = templatesRes ?? [];

  const { data: runsRes, refetch: refetchRuns } = useListReportRuns({ limit: 10 });
  const runs = runsRes ?? [];

  const createTemplate = useCreateReportTemplate();
  const runReport = useRunReport();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDataSources, setNewDataSources] = useState<string[]>(["facilities"]);
  const [newVizType, setNewVizType] = useState("table");

  const DATA_SOURCE_OPTIONS = [
    { value: "facilities", label: "Facilities" },
    { value: "signals", label: "Signals" },
    { value: "contacts", label: "Contacts" },
    { value: "campaigns", label: "Campaigns" },
    { value: "con_filings", label: "CON Filings" },
    { value: "leads", label: "Leads" },
  ];

  const toggleDataSource = (value: string) => {
    setNewDataSources((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const handleCreateTemplate = () => {
    if (!newName.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    if (newDataSources.length === 0) {
      toast({ title: "Select at least one data source", variant: "destructive" });
      return;
    }
    createTemplate.mutate(
      {
        data: {
          name: newName.trim(),
          description: newDescription.trim() || undefined,
          dataSources: newDataSources,
          vizType: newVizType,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Report template created" });
          setCreateOpen(false);
          setNewName("");
          setNewDescription("");
          setNewDataSources(["facilities"]);
          setNewVizType("table");
          refetchTemplates();
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  const handleRun = (templateId: string, templateName: string) => {
    runReport.mutate(
      { data: { templateId } },
      {
        onSuccess: () => {
          toast({
            title: "Report queued",
            description: `"${templateName}" is running. Check Recent Runs for results.`,
          });
          refetchRuns();
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
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground">Custom data exports and analytics.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Report
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Report Templates</CardTitle>
            <CardDescription>Available predefined queries</CardDescription>
          </CardHeader>
          <CardContent>
            {templates.length > 0 ? (
              <div className="space-y-4">
                {templates.map((t) => (
                  <div key={t.id} className="p-4 border rounded-md flex justify-between items-center">
                    <div>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-sm text-muted-foreground">{t.description}</div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={runReport.isPending}
                      onClick={() => handleRun(t.id, t.name)}
                    >
                      Run
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <LineChart className="h-8 w-8 mx-auto mb-2 opacity-20" />
                No templates available.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Runs</CardTitle>
            <CardDescription>Previously executed reports</CardDescription>
          </CardHeader>
          <CardContent>
            {runs.length > 0 ? (
              <div className="space-y-4">
                {runs.map((r) => (
                  <div
                    key={r.id}
                    className="p-3 border rounded-md flex justify-between items-center bg-muted/20"
                  >
                    <div className="text-sm font-medium">Run #{r.id.slice(0, 8)}</div>
                    <div className="text-sm text-muted-foreground">{r.status}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-20" />
                No recent runs.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Report Template</DialogTitle>
            <DialogDescription>Define a reusable report query.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="rpt-name">Name</Label>
              <Input
                id="rpt-name"
                placeholder="e.g. High-Score Facilities by State"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rpt-desc">Description</Label>
              <Textarea
                id="rpt-desc"
                placeholder="What does this report show?"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1">
              <Label>Data Sources <span className="text-red-500">*</span></Label>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {DATA_SOURCE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={newDataSources.includes(opt.value)}
                      onChange={() => toggleDataSource(opt.value)}
                      className="rounded border-border"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rpt-viz">Visualization</Label>
              <Select value={newVizType} onValueChange={setNewVizType}>
                <SelectTrigger id="rpt-viz"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="table">Table</SelectItem>
                  <SelectItem value="bar_chart">Bar Chart</SelectItem>
                  <SelectItem value="line_chart">Line Chart</SelectItem>
                  <SelectItem value="map">Map</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateTemplate} disabled={createTemplate.isPending}>
              {createTemplate.isPending ? "Creating..." : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
