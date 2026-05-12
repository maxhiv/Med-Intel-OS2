import { useState } from "react";
import { useListSequences, useCreateSequence, useAddSequenceStep } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Layers, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function SequencesPage() {
  const { data: sequencesRes, isLoading } = useListSequences();
  const sequences = sequencesRes ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sequences</h1>
          <p className="text-muted-foreground">Manage multi-step outreach playbooks.</p>
        </div>
        <Button><Plus className="mr-2 h-4 w-4" /> New Sequence</Button>
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
                    <div className="text-xs font-medium text-primary mt-2">{seq.totalSteps || 0} Steps • Channel: {seq.channel || 'Email'}</div>
                  </div>
                  <Button variant="outline">Edit</Button>
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
    </div>
  );
}