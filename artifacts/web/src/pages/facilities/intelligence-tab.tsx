import type { ReactElement } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2, DollarSign, MapPin, Network, ArrowLeftRight, Award, Activity,
  AlertTriangle, ExternalLink, Crown,
} from "lucide-react";
import {
  useGetFacilityIntelligence,
  type MedintelCostReport,
  type MedintelChowEvent,
  type MedintelOwnershipEntry,
  type MedintelAcoEntry,
} from "@/hooks/use-facility-intelligence";

function formatMoney(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

function formatNumber(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function chowVerticalLabel(c: MedintelChowEvent | null): string {
  if (!c?.vertical) return "—";
  return c.vertical;
}

function ownerDisplayName(entry: MedintelOwnershipEntry): string {
  if (entry.owner?.organizationName) return entry.owner.organizationName;
  const human = [entry.owner?.firstName, entry.owner?.lastName].filter(Boolean).join(" ");
  return human || `Owner #${entry.ownership.associateIdOwner}`;
}

function ownerFlagBadges(entry: MedintelOwnershipEntry): ReactElement[] {
  const flags: { label: string; cls: string }[] = [];
  if (entry.ownership.isPrivateEquity) flags.push({ label: "PE", cls: "bg-amber-500/15 text-amber-700 border-amber-200" });
  if (entry.ownership.isReit) flags.push({ label: "REIT", cls: "bg-violet-500/15 text-violet-700 border-violet-200" });
  if (entry.ownership.isHoldingCompany) flags.push({ label: "Holding Co", cls: "bg-slate-500/15 text-slate-700 border-slate-200" });
  if (entry.ownership.isChainHomeOffice) flags.push({ label: "Chain HO", cls: "bg-blue-500/15 text-blue-700 border-blue-200" });
  if (entry.owner?.isMgmtServices) flags.push({ label: "MSO", cls: "bg-cyan-500/15 text-cyan-700 border-cyan-200" });
  return flags.map((f) => (
    <Badge key={f.label} variant="outline" className={f.cls}>{f.label}</Badge>
  ));
}

function CostReportPanel({ cr, history }: { cr: MedintelCostReport | null; history?: MedintelCostReport[] }) {
  const safeHistory = history ?? [];
  if (!cr) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><DollarSign className="h-4 w-4" /> HCRIS Financials</CardTitle>
          <CardDescription>No matching cost report found for this CCN.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const items: Array<{ label: string; value: string }> = [
    { label: "Beds", value: formatNumber(cr.numberOfBeds) },
    { label: "Total Discharges", value: formatNumber(cr.totalDischargesAll) },
    { label: "Total Days", value: formatNumber(cr.totalDaysAll) },
    { label: "Total Costs", value: formatMoney(cr.totalCosts) },
    { label: "Net Patient Revenue", value: formatMoney(cr.netPatientRevenue) },
    { label: "Net Income", value: formatMoney(cr.netIncome) },
    { label: "Total Assets", value: formatMoney(cr.totalAssets) },
    { label: "Cash on Hand", value: formatMoney(cr.cashOnHandInBanks) },
    { label: "Investments", value: formatMoney(cr.investments) },
    { label: "Charity Care", value: formatMoney(cr.costOfCharityCare) },
    { label: "Uncompensated Care", value: formatMoney(cr.costOfUncompensatedCare) },
    { label: "Depreciation", value: formatMoney(cr.depreciationCost) },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><DollarSign className="h-4 w-4" /> HCRIS Financials</CardTitle>
        <CardDescription>
          {cr.hospitalName ?? "Hospital"} — Fiscal year ending {formatDate(cr.fiscalYearEndDate)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {items.map((it) => (
            <div key={it.label} className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">{it.label}</div>
              <div className="text-base font-semibold tabular-nums">{it.value}</div>
            </div>
          ))}
        </div>
        {safeHistory.length > 1 ? (
          <div className="mt-4 text-xs text-muted-foreground">
            {safeHistory.length} cost reports on file, oldest fiscal year ending {formatDate(safeHistory[safeHistory.length - 1].fiscalYearEndDate)}.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OwnershipPanel({ entries }: { entries?: MedintelOwnershipEntry[] }) {
  const safeEntries = (entries ?? []).filter((e) => e && e.ownership);
  if (safeEntries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Network className="h-4 w-4" /> Ownership</CardTitle>
          <CardDescription>No ownership records in PECOS.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Network className="h-4 w-4" /> Ownership</CardTitle>
        <CardDescription>{safeEntries.length} ownership records from PECOS, sorted by stake.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {safeEntries.slice(0, 25).map((entry, idx) => (
            <li key={`${entry.ownership.enrollmentId}-${entry.ownership.associateIdOwner}-${entry.ownership.roleCode}-${idx}`} className="py-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium truncate">{ownerDisplayName(entry)}</div>
                <div className="text-xs text-muted-foreground flex flex-wrap gap-1 items-center">
                  {entry.ownership.roleText ? <span>{entry.ownership.roleText}</span> : null}
                  {entry.ownership.percentageOwnership ? <span>· {entry.ownership.percentageOwnership}%</span> : null}
                  {entry.ownership.associationDate ? <span>· since {formatDate(entry.ownership.associationDate)}</span> : null}
                  {entry.owner?.city && entry.owner?.state ? (
                    <span>· {entry.owner.city}, {entry.owner.state}</span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-1 flex-wrap justify-end">{ownerFlagBadges(entry)}</div>
            </li>
          ))}
        </ul>
        {safeEntries.length > 25 ? (
          <div className="mt-3 text-xs text-muted-foreground">Showing top 25 of {safeEntries.length}.</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChowPanel({ recent, history }: { recent: MedintelChowEvent | null; history?: MedintelChowEvent[] }) {
  const safeHistory = history ?? [];
  if (!recent && safeHistory.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" /> Change of Ownership</CardTitle>
          <CardDescription>No CHOW transactions on file.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" /> Change of Ownership</CardTitle>
        <CardDescription>
          {safeHistory.length} CHOW transaction{safeHistory.length === 1 ? "" : "s"} touching this facility.
          {recent ? <> Most recent: <span className="font-medium">{formatDate(recent.effectiveDate)}</span></> : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {safeHistory.slice(0, 10).map((c) => (
            <li key={c.chowPk} className="py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Badge variant="outline">{c.chowTypeText ?? c.chowTypeCode ?? "CHOW"}</Badge>
                <span>{formatDate(c.effectiveDate)}</span>
                <span className="text-xs text-muted-foreground">{chowVerticalLabel(c)}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium">Buyer:</span> {c.organizationNameBuyer ?? "—"}
                <span className="mx-2">→</span>
                <span className="font-medium">Seller:</span> {c.organizationNameSeller ?? "—"}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ServiceAreaPanel({ rows }: { rows?: import("@/hooks/use-facility-intelligence").MedintelServiceAreaRow[] }) {
  const safeRows = rows ?? [];
  if (safeRows.length === 0) return null;
  const top = safeRows.slice(0, 10);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4" /> Service Area</CardTitle>
        <CardDescription>Top {top.length} ZIP codes by patient charges.</CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border">
              <th className="py-2 font-medium">ZIP</th>
              <th className="py-2 font-medium">Year</th>
              <th className="py-2 font-medium text-right">Discharges</th>
              <th className="py-2 font-medium text-right">Patient Days</th>
              <th className="py-2 font-medium text-right">Charges</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => (
              <tr key={`${r.ccn}-${r.zipCode}-${r.calendarYear}`} className="border-b border-border/50">
                <td className="py-2 font-mono">{r.zipCode}</td>
                <td className="py-2">{r.calendarYear}</td>
                <td className="py-2 text-right tabular-nums">{formatNumber(r.totalDischarges)}</td>
                <td className="py-2 text-right tabular-nums">{formatNumber(r.totalDays)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(r.totalCharges)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function AcoPanel({ rows }: { rows?: MedintelAcoEntry[] }) {
  const safeRows = (rows ?? []).filter((r) => r && r.aco);
  if (safeRows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Award className="h-4 w-4" /> ACO / AIP Participation</CardTitle>
        <CardDescription>Medicare Shared Savings Program participation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {safeRows.map((r) => {
          const aipSpending = r.aipSpending ?? [];
          const totalProjected = aipSpending.reduce(
            (sum, a) =>
              sum +
              (Number(a.projectedSpending2024) || 0) +
              (Number(a.projectedSpending2025) || 0) +
              (Number(a.projectedSpending2026) || 0),
            0,
          );
          const totalActual = aipSpending.reduce(
            (sum, a) =>
              sum +
              (Number(a.actualSpending2024) || 0) +
              (Number(a.actualSpending2025) || 0) +
              (Number(a.actualSpending2026) || 0),
            0,
          );
          return (
            <div key={r.aco.acoId} className="rounded-md border border-border p-3">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <div>
                  <div className="font-medium">{r.aco.acoName ?? r.aco.acoId}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.aco.agreeType ?? "—"} · Track {r.aco.currentTrack ?? "—"} · {r.aco.riskModel ?? "—"}
                  </div>
                </div>
                {r.performance?.aipFlag ? <Badge variant="outline">AIP</Badge> : null}
              </div>
              {r.performance ? (
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Beneficiaries:</span> {formatNumber(r.performance.nAb)}</div>
                  <div><span className="text-muted-foreground">Quality:</span> {r.performance.qualScore ?? "—"}</div>
                  <div><span className="text-muted-foreground">Savings Rate:</span> {r.performance.savRate ?? "—"}</div>
                  <div><span className="text-muted-foreground">Year:</span> {r.performance.performanceYear}</div>
                </div>
              ) : null}
              {aipSpending.length > 0 ? (
                <div className="mt-2 text-xs">
                  <span className="text-muted-foreground">AIP Spend ({aipSpending.length} lines):</span>{" "}
                  Projected {formatMoney(totalProjected.toString())} · Actual {formatMoney(totalActual.toString())}
                </div>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ChainPanel({ summary }: { summary: import("@/hooks/use-facility-intelligence").MedintelChainSummary | null }) {
  if (!summary) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Crown className="h-4 w-4" /> Chain / Parent</CardTitle>
        <CardDescription>{summary.chainName}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div><div className="text-xs text-muted-foreground">Facilities owned</div><div className="text-lg font-semibold">{summary.facilitiesOwned ?? "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">States</div><div className="text-sm">{(summary.statesPresent ?? []).join(", ") || "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">Verticals</div><div className="text-sm">{(summary.verticals ?? []).join(", ") || "—"}</div></div>
        </div>
      </CardContent>
    </Card>
  );
}

function CmmiPanel({ rows }: { rows?: import("@/hooks/use-facility-intelligence").MedintelCmmiModel[] }) {
  const safeRows = rows ?? [];
  if (safeRows.length === 0) return null;
  const display = safeRows.slice(0, 8);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" /> CMMI Models in State</CardTitle>
        <CardDescription>Innovation Center programs active in this facility's state.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {display.map((m) => (
            <li key={m.uniqueId} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium truncate">{m.modelName}</div>
                <div className="text-xs text-muted-foreground">
                  {m.category ?? "—"} · {m.stage ?? "—"}
                  {m.dateBegan ? ` · since ${m.dateBegan}` : ""}
                </div>
              </div>
              {m.url ? (
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary inline-flex items-center gap-1 shrink-0">
                  Details <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        {safeRows.length > display.length ? (
          <div className="mt-2 text-xs text-muted-foreground">Showing {display.length} of {safeRows.length}.</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Psi11Panel({ rows }: { rows?: import("@/hooks/use-facility-intelligence").MedintelPsi11Row[] }) {
  const safeRows = rows ?? [];
  if (safeRows.length === 0) return null;
  const latest = safeRows[0];
  const rate = Number(latest.rate ?? 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> AHRQ PSI-11</CardTitle>
        <CardDescription>Post-operative respiratory failure rate.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{rate.toFixed(2)}</span>
          <span className="text-xs text-muted-foreground">per 1,000 elective surgery cases · {latest.startQuarter}</span>
        </div>
        {latest.intervalLowerLimit && latest.intervalHigherLimit ? (
          <div className="text-xs text-muted-foreground mt-1">
            95% CI: {Number(latest.intervalLowerLimit).toFixed(2)}–{Number(latest.intervalHigherLimit).toFixed(2)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function FacilityIntelligenceTab({ facilityId }: { facilityId: string }) {
  const { data, isLoading, error } = useGetFacilityIntelligence(facilityId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Intelligence unavailable</CardTitle>
          <CardDescription>The medintel warehouse could not be reached.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{error.message}</pre>
        </CardContent>
      </Card>
    );
  }

  if (!data || !data.matched) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" /> No PECOS match</CardTitle>
          <CardDescription>
            This facility's CCN or NPI didn't match any enrollment in the medintel warehouse.
            {data?.cmmiModelsInState && data.cmmiModelsInState.length > 0 ? " State-level CMMI signals are still available below." : null}
          </CardDescription>
        </CardHeader>
        {data?.cmmiModelsInState && data.cmmiModelsInState.length > 0 ? (
          <CardContent>
            <CmmiPanel rows={data.cmmiModelsInState} />
          </CardContent>
        ) : null}
      </Card>
    );
  }

  const identity = data.identity ?? null;
  // ownershipFlags can be absent on partial API responses — default every
  // flag so the badge row below never dereferences undefined.
  const ownershipFlags = data.ownershipFlags ?? {
    anyPrivateEquity: false,
    anyReit: false,
    anyHoldingCompany: false,
    anyChainHomeOffice: false,
    anyMgmtServices: false,
    forProfit: null,
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" /> PECOS Identity
            {identity?.ccnAcronym ? <Badge variant="outline">{identity.ccnAcronym}</Badge> : null}
            {identity?.vertical ? <Badge variant="outline">{identity.vertical}</Badge> : null}
          </CardTitle>
          <CardDescription>
            {identity?.organizationName ?? "—"}
            {identity?.doingBusinessAsName ? ` (DBA ${identity.doingBusinessAsName})` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><div className="text-xs text-muted-foreground">CCN</div><div className="font-mono">{identity?.ccn ?? "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">Primary NPI</div><div className="font-mono">{identity?.primaryNpi ?? "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">State</div><div>{identity?.state ?? "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">Address</div><div className="truncate">{identity?.addressLine1 ?? "—"}</div></div>
          </div>
          <div className="mt-3 flex gap-1 flex-wrap">
            {ownershipFlags.anyPrivateEquity ? <Badge variant="outline" className="bg-amber-500/15 text-amber-700 border-amber-200">PE-backed</Badge> : null}
            {ownershipFlags.anyReit ? <Badge variant="outline" className="bg-violet-500/15 text-violet-700 border-violet-200">REIT</Badge> : null}
            {ownershipFlags.anyChainHomeOffice ? <Badge variant="outline" className="bg-blue-500/15 text-blue-700 border-blue-200">Chain</Badge> : null}
            {ownershipFlags.anyHoldingCompany ? <Badge variant="outline" className="bg-slate-500/15 text-slate-700 border-slate-200">Holding Co</Badge> : null}
            {ownershipFlags.forProfit === true ? <Badge variant="outline">For-profit</Badge> : null}
            {ownershipFlags.forProfit === false ? <Badge variant="outline">Non-profit</Badge> : null}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="ownership" className="space-y-4">
        <TabsList>
          <TabsTrigger value="ownership">Ownership</TabsTrigger>
          <TabsTrigger value="financials">Financials</TabsTrigger>
          <TabsTrigger value="chow">CHOW</TabsTrigger>
          <TabsTrigger value="catchment">Catchment</TabsTrigger>
          <TabsTrigger value="programs">Programs</TabsTrigger>
          <TabsTrigger value="quality">Quality</TabsTrigger>
        </TabsList>

        <TabsContent value="ownership" className="space-y-4">
          <ChainPanel summary={data.chainSummary} />
          <OwnershipPanel entries={data.owners} />
        </TabsContent>

        <TabsContent value="financials" className="space-y-4">
          <CostReportPanel cr={data.costReport} history={data.costReportHistory} />
        </TabsContent>

        <TabsContent value="chow" className="space-y-4">
          <ChowPanel recent={data.recentChow} history={data.chowHistory} />
        </TabsContent>

        <TabsContent value="catchment" className="space-y-4">
          <ServiceAreaPanel rows={data.serviceArea} />
        </TabsContent>

        <TabsContent value="programs" className="space-y-4">
          <AcoPanel rows={data.acoParticipation} />
          <CmmiPanel rows={data.cmmiModelsInState} />
        </TabsContent>

        <TabsContent value="quality" className="space-y-4">
          <Psi11Panel rows={data.psi11} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
