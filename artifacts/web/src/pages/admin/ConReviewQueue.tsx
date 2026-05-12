import { useState } from "react";
import {
  useAdminListConFilingReviewQueue,
  useAdminReviewConFiling,
  adminSearchFacilities,
} from "@workspace/api-client-react";
import type {
  ConFilingReviewItem,
  AdminFacilitySearchResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, AlertTriangle, Check, X, Shuffle } from "lucide-react";

function ReassignDialog({
  filing,
  onClose,
  onReassign,
}: {
  filing: ConFilingReviewItem;
  onClose: () => void;
  onReassign: (facilityId: string, notes: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminFacilitySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AdminFacilitySearchResult | null>(null);
  const [notes, setNotes] = useState("");

  const handleSearch = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await adminSearchFacilities({ q: query.trim(), state: filing.state });
      setResults(res);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Reassign CON filing match</DialogTitle>
          <DialogDescription>
            Find the correct facility for "{filing.applicantName ?? "this filing"}" in {filing.state}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="Search by name, DBA, system, or NPI…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            data-testid="input-reassign-search"
          />
          <Button onClick={handleSearch} disabled={searching} data-testid="button-reassign-search">
            Search
          </Button>
        </div>
        <div className="max-h-60 overflow-y-auto border rounded-md divide-y">
          {results.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No results yet.</div>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelected(r)}
                className={`w-full text-left p-3 text-sm hover-elevate ${
                  selected?.id === r.id ? "bg-accent" : ""
                }`}
                data-testid={`button-reassign-pick-${r.id}`}
              >
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-muted-foreground">
                  {[r.systemName, r.city, r.state, r.npi && `NPI ${r.npi}`]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </button>
            ))
          )}
        </div>
        <Textarea
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          data-testid="input-reassign-notes"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            onClick={() => selected && onReassign(selected.id, notes)}
            data-testid="button-reassign-confirm"
          >
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConReviewQueue() {
  const { data, isLoading, refetch } = useAdminListConFilingReviewQueue();
  const review = useAdminReviewConFiling();
  const { toast } = useToast();
  const [reassigning, setReassigning] = useState<ConFilingReviewItem | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});

  const items = data?.data ?? [];
  const threshold = data?.reviewThreshold ?? 0.75;

  const act = (
    id: string,
    body: { action: "confirm" | "reject" | "reassign"; facilityId?: string; notes?: string },
    label: string,
  ) => {
    review.mutate(
      { id, data: body },
      {
        onSuccess: () => {
          toast({ title: label });
          setReassigning(null);
          refetch();
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : "Action failed";
          toast({ title: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          CON Filing Review Queue
        </CardTitle>
        <CardDescription>
          Auto-emitted matches with confidence below {threshold.toFixed(2)} land here. Confirm to
          keep the purchase signal, reject to deactivate it, or reassign to the right facility.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="text-review-queue-empty">
            Nothing waiting for review.
          </div>
        ) : (
          <div className="space-y-3" data-testid="list-review-queue">
            {items.map((it) => {
              const noteVal = notesById[it.id] ?? "";
              return (
                <div
                  key={it.id}
                  className="border rounded-md p-4 space-y-3"
                  data-testid={`row-review-${it.id}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="font-medium">
                        {it.applicantName ?? "(unnamed applicant)"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[it.state, it.modality, it.equipmentType, it.status]
                          .filter(Boolean)
                          .join(" · ")}
                        {it.filingDate ? ` · filed ${it.filingDate}` : ""}
                      </div>
                      {it.filingUrl && (
                        <a
                          href={it.filingUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary inline-flex items-center gap-1"
                        >
                          source <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="secondary">
                        score {it.matchScore == null ? "—" : it.matchScore.toFixed(2)}
                      </Badge>
                      {it.matchField && (
                        <Badge variant="outline">via {it.matchField}</Badge>
                      )}
                    </div>
                  </div>
                  <div className="text-sm bg-muted/40 rounded p-2">
                    <div className="font-medium">
                      Auto-matched to: {it.facilityName ?? "(unknown)"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[it.facilitySystem, it.facilityCity, it.facilityState]
                        .filter(Boolean)
                        .join(" · ") || "no location data"}
                    </div>
                  </div>
                  <Textarea
                    placeholder="Reviewer notes (optional)"
                    value={noteVal}
                    onChange={(e) =>
                      setNotesById((m) => ({ ...m, [it.id]: e.target.value }))
                    }
                    data-testid={`input-review-notes-${it.id}`}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        act(it.id, { action: "confirm", notes: noteVal }, "Match confirmed")
                      }
                      data-testid={`button-review-confirm-${it.id}`}
                    >
                      <Check className="h-4 w-4 mr-1" /> Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        act(it.id, { action: "reject", notes: noteVal }, "Match rejected")
                      }
                      data-testid={`button-review-reject-${it.id}`}
                    >
                      <X className="h-4 w-4 mr-1" /> Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReassigning(it)}
                      data-testid={`button-review-reassign-${it.id}`}
                    >
                      <Shuffle className="h-4 w-4 mr-1" /> Reassign
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {reassigning && (
        <ReassignDialog
          filing={reassigning}
          onClose={() => setReassigning(null)}
          onReassign={(facilityId, notes) =>
            act(
              reassigning.id,
              { action: "reassign", facilityId, notes },
              "Match reassigned",
            )
          }
        />
      )}
    </Card>
  );
}
