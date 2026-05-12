import { useListReportTemplates, useListReportRuns } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Plus, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ReportsPage() {
  const { data: templatesRes } = useListReportTemplates();
  const templates = templatesRes?.data || [];
  
  const { data: runsRes } = useListReportRuns({ limit: 10 });
  const runs = runsRes?.data || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground">Custom data exports and analytics.</p>
        </div>
        <Button><Plus className="mr-2 h-4 w-4" /> New Report</Button>
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
                {templates.map(t => (
                  <div key={t.id} className="p-4 border rounded-md flex justify-between items-center">
                    <div>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-sm text-muted-foreground">{t.description}</div>
                    </div>
                    <Button variant="secondary" size="sm">Run</Button>
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
                {runs.map(r => (
                  <div key={r.id} className="p-3 border rounded-md flex justify-between items-center bg-muted/20">
                    <div className="text-sm font-medium">Run #{r.id.slice(0,8)}</div>
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
    </div>
  );
}