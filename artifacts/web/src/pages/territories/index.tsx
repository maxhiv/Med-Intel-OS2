import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListTerritories,
  useListEquipmentLines,
  usePreviewTerritory,
  useCreateTerritory,
  useDeleteTerritory,
  type TerritoryFilter,
  type ViewKind,
  type TerritoryFacility,
} from "@/hooks/use-territory";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Save, Eye, Map as MapIcon, Table as TableIcon, Plus, Loader2 } from "lucide-react";
import { TerritoryFilterPanel } from "@/components/territory-filter-panel";

// MapLibre is ~600 KB minified; lazy so the territory planner's first paint
// stays fast and reps who only use the table view never pay for the map.
const TerritoryMap = lazy(() =>
  import("@/components/territory-map").then((m) => ({ default: m.TerritoryMap })),
);
import { useToast } from "@/hooks/use-toast";

const DEFAULT_FILTER: TerritoryFilter = {
  limit: 100,
  offset: 0,
  sortBy: "score_desc",
};

function fmtMoney(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtNum(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString();
}

function FlagsCell({ f }: { f: TerritoryFacility }) {
  return (
    <div className="flex flex-wrap gap-1">
      {f.flags.privateEquity ? <Badge variant="outline" className="bg-amber-500/15 text-amber-700 border-amber-200 text-[10px]">PE</Badge> : null}
      {f.flags.reit ? <Badge variant="outline" className="bg-violet-500/15 text-violet-700 border-violet-200 text-[10px]">REIT</Badge> : null}
      {f.flags.chain ? <Badge variant="outline" className="bg-blue-500/15 text-blue-700 border-blue-200 text-[10px]">Chain</Badge> : null}
      {f.flags.recentChow ? <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 border-emerald-200 text-[10px]">CHOW</Badge> : null}
      {f.flags.aipInfraSpend ? <Badge variant="outline" className="bg-teal-500/15 text-teal-700 border-teal-200 text-[10px]">AIP</Badge> : null}
      {f.flags.sellerSideChow ? <Badge variant="outline" className="bg-rose-500/15 text-rose-700 border-rose-200 text-[10px]">SELLER</Badge> : null}
      {f.flags.hcrisNetIncomeYoyDecline ? <Badge variant="outline" className="bg-rose-500/10 text-rose-700 border-rose-200 text-[10px]">NI↓</Badge> : null}
      {f.flags.hcrisCashYoyDecline ? <Badge variant="outline" className="bg-rose-500/10 text-rose-700 border-rose-200 text-[10px]">CASH↓</Badge> : null}
    </div>
  );
}

function TerritoryTable({ rows }: { rows: TerritoryFacility[] }) {
  const [sortKey, setSortKey] = useState<"score" | "name" | "beds" | "npr">("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const c = [...rows];
    c.sort((a, b) => {
      const sa = a.equipmentScore ?? a.baseScore;
      const sb = b.equipmentScore ?? b.baseScore;
      let cmp = 0;
      if (sortKey === "score") cmp = sa - sb;
      else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "beds") cmp = (a.hcris?.beds ?? 0) - (b.hcris?.beds ?? 0);
      else if (sortKey === "npr") cmp = (a.hcris?.netPatientRevenue ?? 0) - (b.hcris?.netPatientRevenue ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return c;
  }, [rows, sortKey, sortDir]);

  function HeaderCell({ k, label, align = "left" }: { k: typeof sortKey; label: string; align?: "left" | "right" }) {
    const active = sortKey === k;
    return (
      <th
        className={`py-2 px-2 text-xs uppercase font-medium cursor-pointer select-none ${align === "right" ? "text-right" : "text-left"}`}
        onClick={() => {
          if (active) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else { setSortKey(k); setSortDir("desc"); }
        }}
      >
        {label}{active ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
      </th>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 border-b border-border">
          <tr>
            <HeaderCell k="score" label="Score" />
            <HeaderCell k="name" label="Facility" />
            <th className="py-2 px-2 text-xs uppercase font-medium text-left">Type</th>
            <th className="py-2 px-2 text-xs uppercase font-medium text-left">Location</th>
            <HeaderCell k="beds" label="Beds" align="right" />
            <HeaderCell k="npr" label="Net Pt. Revenue" align="right" />
            <th className="py-2 px-2 text-xs uppercase font-medium text-left">Flags</th>
            <th className="py-2 px-2 text-xs uppercase font-medium text-left">—</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => (
            <tr key={f.id} className="border-b border-border/40 hover:bg-muted/30">
              <td className="py-2 px-2 font-semibold tabular-nums">
                <span className={(f.equipmentScore ?? f.baseScore) >= 70 ? "text-red-600" : (f.equipmentScore ?? f.baseScore) >= 50 ? "text-orange-600" : ""}>
                  {f.equipmentScore ?? f.baseScore}
                </span>
                {f.equipmentScore != null ? (
                  <span className="text-[10px] text-muted-foreground ml-1">/ {f.baseScore}</span>
                ) : null}
              </td>
              <td className="py-2 px-2">
                <Link href={`/facilities/${f.id}`} className="font-medium hover:underline">{f.name}</Link>
                {f.doingBusinessAs ? <div className="text-xs text-muted-foreground">DBA {f.doingBusinessAs}</div> : null}
              </td>
              <td className="py-2 px-2 text-xs">{f.facilityType}</td>
              <td className="py-2 px-2 text-xs">{[f.city, f.state].filter(Boolean).join(", ")}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmtNum(f.hcris?.beds ?? null)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{fmtMoney(f.hcris?.netPatientRevenue ?? null)}</td>
              <td className="py-2 px-2"><FlagsCell f={f} /></td>
              <td className="py-2 px-2 text-right">
                <Link href={`/facilities/${f.id}`}>
                  <Button variant="ghost" size="sm">Open</Button>
                </Link>
              </td>
            </tr>
          ))}
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
                No facilities match this filter. Try loosening it.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export default function TerritoriesPage() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<TerritoryFilter>(DEFAULT_FILTER);
  const [viewKind, setViewKind] = useState<ViewKind>("buy_side");
  const [equipmentLineSlug, setEquipmentLineSlug] = useState<string | undefined>();
  const [displayMode, setDisplayMode] = useState<"table" | "map">("table");
  const [results, setResults] = useState<TerritoryFacility[]>([]);
  const [total, setTotal] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");

  const { toast } = useToast();
  const equipmentLines = useListEquipmentLines();
  const territories = useListTerritories();
  const preview = usePreviewTerritory();
  const createTerritory = useCreateTerritory();
  const deleteTerritory = useDeleteTerritory();

  function runPreview() {
    setPreviewError(null);
    preview.mutate(
      { filter, viewKind, equipmentLineSlug },
      {
        onSuccess: (data) => {
          setResults(data.results);
          setTotal(data.total);
        },
        onError: (err) => setPreviewError(err.message),
      },
    );
  }

  function onSave() {
    if (!saveName.trim()) return;
    createTerritory.mutate(
      {
        name: saveName.trim(),
        description: saveDescription.trim() || undefined,
        viewKind,
        filter,
        equipmentLineSlug: equipmentLineSlug ?? null,
      },
      {
        onSuccess: (t) => {
          setSaveOpen(false);
          setSaveName("");
          setSaveDescription("");
          toast({ title: "Territory saved", description: `${t.name} (${total} prospects)` });
        },
        onError: (err) => toast({ variant: "destructive", title: "Save failed", description: err.message }),
      },
    );
  }

  function loadTerritory(id: string) {
    const t = territories.data?.data.find((x) => x.id === id);
    if (!t) return;
    setFilter(t.filter ?? DEFAULT_FILTER);
    setViewKind(t.viewKind);
    setEquipmentLineSlug(t.equipmentLineSlug ?? undefined);
    setResults([]);
    setTotal(0);
    navigate(`/territories/${id}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Territory Planner</h1>
          <p className="text-sm text-muted-foreground">
            Build a filtered list of qualified prospects. Save it, re-run quarterly against fresh CMS data, export to your CRM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={displayMode === "table" ? "default" : "outline"}
            size="sm"
            onClick={() => setDisplayMode("table")}
          >
            <TableIcon className="h-4 w-4 mr-1" /> Table
          </Button>
          <Button
            variant={displayMode === "map" ? "default" : "outline"}
            size="sm"
            onClick={() => setDisplayMode("map")}
          >
            <MapIcon className="h-4 w-4 mr-1" /> Map
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        <div className="space-y-3">
          <TerritoryFilterPanel
            filter={filter}
            viewKind={viewKind}
            equipmentLineSlug={equipmentLineSlug}
            equipmentLines={equipmentLines.data?.data ?? []}
            onChange={setFilter}
            onViewKindChange={setViewKind}
            onEquipmentLineChange={setEquipmentLineSlug}
          />
          <div className="flex gap-2">
            <Button onClick={runPreview} disabled={preview.isPending} className="flex-1">
              {preview.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Eye className="h-4 w-4 mr-1" />}
              Preview
            </Button>
            <Button variant="outline" onClick={() => setSaveOpen(true)}>
              <Save className="h-4 w-4 mr-1" /> Save
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Saved territories</CardTitle>
              <CardDescription>{territories.data?.data.length ?? 0} saved</CardDescription>
            </CardHeader>
            <CardContent>
              {territories.isLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : territories.data?.data.length === 0 ? (
                <div className="text-sm text-muted-foreground">No saved territories yet. Configure filters and click <em>Save</em>.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {territories.data?.data.map((t) => (
                    <li key={t.id} className="py-2 flex items-center justify-between gap-2">
                      <button onClick={() => loadTerritory(t.id)} className="text-left flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{t.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {t.viewKind === "sell_side" ? "Sell-side" : "Buy-side"}
                          {t.equipmentLineSlug ? ` · ${t.equipmentLineSlug}` : ""}
                          {t.description ? ` · ${t.description}` : ""}
                        </div>
                      </button>
                      <Button variant="ghost" size="sm" onClick={() => deleteTerritory.mutate(t.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {previewError ? (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="p-3 text-sm">{previewError}</CardContent>
            </Card>
          ) : null}

          {preview.isPending ? (
            <Skeleton className="h-96 w-full" />
          ) : results.length > 0 || total > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  {total} prospect{total === 1 ? "" : "s"}
                  {equipmentLineSlug ? ` · ${equipmentLineSlug} lens` : ""}
                </CardTitle>
                <CardDescription>
                  Showing {Math.min(results.length, filter.limit ?? 100)} of {total}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {displayMode === "map" ? (
                  <div className="h-[600px]">
                    <Suspense fallback={<Skeleton className="w-full h-full rounded-md" />}>
                      <TerritoryMap facilities={results} className="w-full h-full rounded-md border border-border" />
                    </Suspense>
                  </div>
                ) : (
                  <TerritoryTable rows={results} />
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground space-y-2">
                <Plus className="h-10 w-10 mx-auto opacity-30" />
                <p>Pick filters on the left, then <em>Preview</em> to see prospects.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save territory</DialogTitle>
            <DialogDescription>Reuse this filter quarterly as fresh CMS data lands.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. IL/IN Mid-size PE-backed" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={onSave} disabled={!saveName.trim() || createTerritory.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
