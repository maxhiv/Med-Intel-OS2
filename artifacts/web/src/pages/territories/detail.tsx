import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  useGetTerritory,
  useGetTerritoryFacilities,
  useDeleteTerritory,
  type TerritoryFacility,
} from "@/hooks/use-territory";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Map as MapIcon, Table as TableIcon, Trash2, ArrowLeft, Download } from "lucide-react";
import { TerritoryMap } from "@/components/territory-map";
import { useToast } from "@/hooks/use-toast";

function fmtMoney(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function flagsText(f: TerritoryFacility): string {
  const out: string[] = [];
  if (f.flags.privateEquity) out.push("PE");
  if (f.flags.reit) out.push("REIT");
  if (f.flags.chain) out.push("Chain");
  if (f.flags.recentChow) out.push("CHOW");
  if (f.flags.aipInfraSpend) out.push("AIP");
  if (f.flags.sellerSideChow) out.push("Seller");
  if (f.flags.hcrisNetIncomeYoyDecline) out.push("NI↓");
  if (f.flags.hcrisCashYoyDecline) out.push("Cash↓");
  return out.join("|");
}

function downloadCsv(rows: TerritoryFacility[], name: string) {
  const headers = [
    "facility_id", "name", "facility_type", "city", "state", "zip", "npi", "ccn",
    "score", "base_score", "equipment_score", "beds", "net_patient_revenue",
    "total_assets", "cash_on_hand", "net_income", "flags",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const cells = [
      r.id,
      JSON.stringify(r.name),
      JSON.stringify(r.facilityType),
      JSON.stringify(r.city ?? ""),
      r.state ?? "",
      r.zip ?? "",
      r.npi,
      r.cmsId ?? "",
      String(r.equipmentScore ?? r.baseScore),
      String(r.baseScore),
      r.equipmentScore == null ? "" : String(r.equipmentScore),
      r.hcris?.beds ?? "",
      r.hcris?.netPatientRevenue ?? "",
      r.hcris?.totalAssets ?? "",
      r.hcris?.cashOnHand ?? "",
      r.hcris?.netIncome ?? "",
      flagsText(r),
    ];
    lines.push(cells.join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9-_]+/gi, "_")}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TerritoryDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();

  const [displayMode, setDisplayMode] = useState<"table" | "map">("table");
  const [sortBy, setSortBy] = useState<"score_desc" | "name" | "beds_desc" | "revenue_desc">("score_desc");

  const territory = useGetTerritory(id);
  const facilitiesQ = useGetTerritoryFacilities(id, { limit: 250, sortBy });
  const deleteTerritory = useDeleteTerritory();

  const rows = facilitiesQ.data?.results ?? [];
  const total = facilitiesQ.data?.total ?? 0;

  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    return {
      avgScore: Math.round(rows.reduce((s, r) => s + (r.equipmentScore ?? r.baseScore), 0) / rows.length),
      pe: rows.filter((r) => r.flags.privateEquity).length,
      reit: rows.filter((r) => r.flags.reit).length,
      chow: rows.filter((r) => r.flags.recentChow).length,
      aip: rows.filter((r) => r.flags.aipInfraSpend).length,
      distress: rows.filter((r) => r.flags.sellerSideChow || r.flags.hcrisNetIncomeYoyDecline).length,
    };
  }, [rows]);

  if (territory.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!territory.data) {
    return (
      <Card>
        <CardHeader><CardTitle>Territory not found</CardTitle></CardHeader>
        <CardContent>
          <Link href="/territories">
            <Button variant="outline" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back to territories</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }
  const t = territory.data;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <Link href="/territories" className="text-xs text-muted-foreground hover:underline">
            ← All territories
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
          <div className="text-sm text-muted-foreground">
            <Badge variant="outline" className="mr-2">{t.viewKind === "sell_side" ? "Sell-side" : "Buy-side"}</Badge>
            {t.equipmentLineSlug ? <Badge variant="outline" className="mr-2">{t.equipmentLineSlug} lens</Badge> : null}
            {t.description ?? ""}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant={displayMode === "table" ? "default" : "outline"} size="sm" onClick={() => setDisplayMode("table")}>
            <TableIcon className="h-4 w-4 mr-1" /> Table
          </Button>
          <Button variant={displayMode === "map" ? "default" : "outline"} size="sm" onClick={() => setDisplayMode("map")}>
            <MapIcon className="h-4 w-4 mr-1" /> Map
          </Button>
          <Button variant="outline" size="sm" onClick={() => downloadCsv(rows, t.name)} disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              deleteTerritory.mutate(id, {
                onSuccess: () => {
                  toast({ title: "Territory deleted" });
                  window.location.assign("/territories");
                },
              })
            }
          >
            <Trash2 className="h-4 w-4 mr-1" /> Delete
          </Button>
        </div>
      </div>

      {summary ? (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Prospects</div><div className="text-xl font-semibold">{total}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Avg score</div><div className="text-xl font-semibold">{summary.avgScore}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">PE-backed</div><div className="text-xl font-semibold">{summary.pe}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">REIT</div><div className="text-xl font-semibold">{summary.reit}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Recent CHOW</div><div className="text-xl font-semibold">{summary.chow}</div></CardContent></Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">{t.viewKind === "sell_side" ? "Distress signals" : "AIP infra spend"}</div>
              <div className="text-xl font-semibold">{t.viewKind === "sell_side" ? summary.distress : summary.aip}</div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{rows.length} of {total} shown</CardTitle>
          <CardDescription>
            Sort:
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="ml-2 text-xs border border-border rounded px-2 py-1 bg-background"
            >
              <option value="score_desc">Score (high → low)</option>
              <option value="name">Name (A → Z)</option>
              <option value="beds_desc">Beds (high → low)</option>
              <option value="revenue_desc">Net Patient Revenue (high → low)</option>
            </select>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {facilitiesQ.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : displayMode === "map" ? (
            <div className="h-[600px]">
              <TerritoryMap facilities={rows} className="w-full h-full rounded-md border border-border" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-left">Score</th>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-left">Facility</th>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-left">Type</th>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-left">Location</th>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-right">Beds</th>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-right">Net Patient Rev.</th>
                    <th className="py-2 px-2 text-xs uppercase font-medium text-left">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-2 px-2 font-semibold tabular-nums">
                        {f.equipmentScore ?? f.baseScore}
                        {f.equipmentScore != null ? <span className="text-[10px] text-muted-foreground ml-1">/ {f.baseScore}</span> : null}
                      </td>
                      <td className="py-2 px-2">
                        <Link href={`/facilities/${f.id}`} className="font-medium hover:underline">{f.name}</Link>
                      </td>
                      <td className="py-2 px-2 text-xs">{f.facilityType}</td>
                      <td className="py-2 px-2 text-xs">{[f.city, f.state].filter(Boolean).join(", ")}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{f.hcris?.beds?.toLocaleString() ?? "—"}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{fmtMoney(f.hcris?.netPatientRevenue ?? null)}</td>
                      <td className="py-2 px-2">
                        <div className="flex flex-wrap gap-1">
                          {f.flags.privateEquity ? <Badge variant="outline" className="text-[10px]">PE</Badge> : null}
                          {f.flags.reit ? <Badge variant="outline" className="text-[10px]">REIT</Badge> : null}
                          {f.flags.chain ? <Badge variant="outline" className="text-[10px]">Chain</Badge> : null}
                          {f.flags.recentChow ? <Badge variant="outline" className="text-[10px]">CHOW</Badge> : null}
                          {f.flags.aipInfraSpend ? <Badge variant="outline" className="text-[10px]">AIP</Badge> : null}
                          {f.flags.sellerSideChow ? <Badge variant="outline" className="text-[10px]">Seller</Badge> : null}
                          {f.flags.hcrisNetIncomeYoyDecline ? <Badge variant="outline" className="text-[10px]">NI↓</Badge> : null}
                          {f.flags.hcrisCashYoyDecline ? <Badge variant="outline" className="text-[10px]">Cash↓</Badge> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">No matches.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
