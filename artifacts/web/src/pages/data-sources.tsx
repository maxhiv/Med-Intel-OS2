import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Database, CheckCircle2, AlertTriangle, Clock, ChevronDown, ChevronRight } from "lucide-react";

type SourceStatus = "Live" | "Partial" | "Pending";
type Tier = "A" | "B" | "C";
type AccessType = "Public API" | "Requires Key" | "OAuth";

interface DataSource {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: Tier;
  accessType: AccessType;
  status: SourceStatus;
  refreshCadence: string;
}

const DATA_SOURCES: DataSource[] = [
  {
    id: "con_filings",
    name: "State CON Filings",
    description: "Certificate-of-Need applications across 22 active CON states — highest-intent equipment signal. Data is scraped directly from each state regulatory portal daily.",
    category: "State Regulatory",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily at 05:00",
  },
  {
    id: "clinical_trials",
    name: "ClinicalTrials.gov",
    description: "Active clinical trials for new equipment and procedures at enrolled facilities. Indicates near-term procurement of trial-specific devices.",
    category: "Federal",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily at 04:30",
  },
  {
    id: "fda_510k",
    name: "FDA 510(k) Clearances",
    description: "Pre-market notification clearances showing recently approved medical devices. Drives replacement purchase cycles as facilities upgrade to cleared devices.",
    category: "FDA",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily",
  },
  {
    id: "fda_recalls",
    name: "FDA Device Recalls",
    description: "Active equipment recall notices that drive accelerated replacement cycles. A recall against an installed device is a near-term purchase signal.",
    category: "FDA",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily",
  },
  {
    id: "fda_maude",
    name: "FDA MAUDE Adverse Events",
    description: "Medical device malfunction and adverse event reports indicating equipment failure patterns. Repeated failures predict replacement demand.",
    category: "FDA",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily",
  },
  {
    id: "hcris",
    name: "HCRIS Cost Reports",
    description: "Hospital Cost Report Information System — depreciation spikes and asset replacement signals. High depreciation on a specific asset class predicts near-term capital spend.",
    category: "Federal",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Quarterly",
  },
  {
    id: "sec_edgar",
    name: "SEC EDGAR Filings",
    description: "Public company 10-K and 8-K filings for capex guidance and equipment purchase disclosures. CFO commentary on upcoming capital programs is a strong forward signal.",
    category: "Financial",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily",
  },
  {
    id: "emma_bonds",
    name: "EMMA Municipal Bonds",
    description: "Municipal bond issuances for hospital capital projects — strong CON corroboration signal. A bond issuance following a CON approval confirms the project is funded.",
    category: "Financial",
    tier: "A",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "usa_spending",
    name: "USASpending.gov",
    description: "Federal contract and grant award data surfacing government-funded equipment purchases. Indicates equipment procurement at VA hospitals, military health, and federally funded clinics.",
    category: "Federal",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Daily",
  },
  {
    id: "nppes",
    name: "NPPES / NPI Registry",
    description: "National Provider Identifier registry for facility contact and taxonomy enrichment. Used to match CON applicants to facility records and enrich contact data.",
    category: "Federal",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "cms_data",
    name: "CMS Open Payments / IPPS",
    description: "Centers for Medicare & Medicaid Services data including cost report and utilization signals. High procedure volume on aging equipment predicts replacement demand.",
    category: "Federal",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "fda_class",
    name: "FDA Device Classification",
    description: "Regulatory device class database used to enrich equipment type signals. Maps unstructured equipment descriptions to standard device categories.",
    category: "FDA",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "propublica_990",
    name: "ProPublica 990 Filings",
    description: "Non-profit hospital 990 filings for capital expenditure and financial health signals. Schedule B and property schedules reveal planned equipment spend.",
    category: "Non-Profit",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "hrsa",
    name: "HRSA Grant Awards",
    description: "Health Resources & Services Administration grants for facility upgrades and equipment. Equipment grants are direct purchase intent signals.",
    category: "Federal",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "usda",
    name: "USDA Rural Development",
    description: "Rural hospital and clinic grants indicating equipment purchase intent. USDA Community Facilities grants directly fund equipment at rural critical-access hospitals.",
    category: "Federal",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Weekly",
  },
  {
    id: "medicare_util",
    name: "Medicare Utilization",
    description: "Procedure-level Medicare utilization data surfacing high-volume equipment demand signals. Tracks procedure growth rates that predict capacity-driven equipment upgrades.",
    category: "Federal",
    tier: "B",
    accessType: "Public API",
    status: "Live",
    refreshCadence: "Monthly",
  },
  {
    id: "sam_gov",
    name: "SAM.gov / FedBizOpps",
    description: "Federal acquisition opportunities and RFPs for medical equipment. Direct procurement signals when federal agencies post solicitations for imaging, lab, or surgical equipment.",
    category: "Federal",
    tier: "B",
    accessType: "Requires Key",
    status: "Partial",
    refreshCadence: "Daily",
  },
  {
    id: "ghl_crm",
    name: "GoHighLevel CRM",
    description: "Sub-account CRM integration for opportunity creation and outreach task management. CON filings and signals are pushed as pipeline opportunities via direct GHL API.",
    category: "CRM",
    tier: "B",
    accessType: "Requires Key",
    status: "Live",
    refreshCadence: "On push",
  },
  {
    id: "zerobounce",
    name: "ZeroBounce Email Validation",
    description: "Async email address validation for contact enrichment. Validates contact emails before outreach to reduce bounce rates and protect sender reputation.",
    category: "Enrichment",
    tier: "C",
    accessType: "Requires Key",
    status: "Partial",
    refreshCadence: "On demand",
  },
  {
    id: "bouncer",
    name: "Bouncer Email Validation",
    description: "Secondary email validation provider — used as fallback when ZeroBounce confidence is low. Provides redundancy for contact deliverability verification.",
    category: "Enrichment",
    tier: "C",
    accessType: "Requires Key",
    status: "Partial",
    refreshCadence: "On demand",
  },
  {
    id: "hubspot_crm",
    name: "HubSpot CRM",
    description: "HubSpot OAuth integration for contact sync and deal pipeline management. Planned for Q3; will support bi-directional sync of facility contacts and CON-based deals.",
    category: "CRM",
    tier: "C",
    accessType: "OAuth",
    status: "Pending",
    refreshCadence: "On push",
  },
  {
    id: "salesforce_crm",
    name: "Salesforce CRM",
    description: "Salesforce OAuth integration for lead and opportunity management. Planned for Q4; supports enterprise accounts that run Salesforce as their CRM of record.",
    category: "CRM",
    tier: "C",
    accessType: "OAuth",
    status: "Pending",
    refreshCadence: "On push",
  },
];

const ALL_TIERS: Tier[] = ["A", "B", "C"];
const ALL_ACCESS_TYPES: AccessType[] = ["Public API", "Requires Key", "OAuth"];

const TIER_BADGE: Record<Tier, string> = {
  A: "bg-red-500/10 text-red-700 border-red-200",
  B: "bg-yellow-500/10 text-yellow-700 border-yellow-200",
  C: "bg-muted text-muted-foreground border-border",
};

function StatusBadge({ status }: { status: SourceStatus }) {
  if (status === "Live") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/10 text-green-600 border border-green-200">
        <CheckCircle2 className="h-3 w-3" />
        Live
      </span>
    );
  }
  if (status === "Partial") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/10 text-yellow-700 border border-yellow-200">
        <AlertTriangle className="h-3 w-3" />
        Partial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground border border-border">
      <Clock className="h-3 w-3" />
      Pending
    </span>
  );
}

const STATUS_COUNTS = {
  Live:    DATA_SOURCES.filter((s) => s.status === "Live").length,
  Partial: DATA_SOURCES.filter((s) => s.status === "Partial").length,
  Pending: DATA_SOURCES.filter((s) => s.status === "Pending").length,
};

export default function DataSourcesPage() {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [accessFilter, setAccessFilter] = useState<string>("all");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = DATA_SOURCES.filter((src) => {
    const q = search.toLowerCase();
    if (q && !src.name.toLowerCase().includes(q) && !src.description.toLowerCase().includes(q) && !src.category.toLowerCase().includes(q)) return false;
    if (tierFilter !== "all" && src.tier !== tierFilter) return false;
    if (accessFilter !== "all" && src.accessType !== accessFilter) return false;
    return true;
  });

  const hasFilters = search || tierFilter !== "all" || accessFilter !== "all";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Data Sources</h1>
        <p className="text-muted-foreground">
          All {DATA_SOURCES.length} signal sources powering MedIntel OS — from federal databases to state regulators and CRM integrations.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="py-4 text-center">
          <div className="text-3xl font-bold">{DATA_SOURCES.length}</div>
          <div className="text-xs text-muted-foreground mt-1">Total Sources</div>
        </Card>
        <Card className="py-4 text-center">
          <div className="text-3xl font-bold text-green-600">{STATUS_COUNTS.Live}</div>
          <div className="text-xs text-muted-foreground mt-1">Live</div>
        </Card>
        <Card className="py-4 text-center">
          <div className="text-3xl font-bold text-yellow-700">{STATUS_COUNTS.Partial}</div>
          <div className="text-xs text-muted-foreground mt-1">Partial</div>
        </Card>
        <Card className="py-4 text-center">
          <div className="text-3xl font-bold text-muted-foreground">{STATUS_COUNTS.Pending}</div>
          <div className="text-xs text-muted-foreground mt-1">Pending</div>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Input
          placeholder="Search sources…"
          className="w-[220px] h-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-search-sources"
        />
        <Select value={tierFilter} onValueChange={setTierFilter}>
          <SelectTrigger className="w-[130px] h-9" data-testid="select-tier">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            {ALL_TIERS.map((t) => (
              <SelectItem key={t} value={t}>Tier {t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={accessFilter} onValueChange={setAccessFilter}>
          <SelectTrigger className="w-[150px] h-9" data-testid="select-access-type">
            <SelectValue placeholder="Access type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All access types</SelectItem>
            {ALL_ACCESS_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <button
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2"
            onClick={() => { setSearch(""); setTierFilter("all"); setAccessFilter("all"); }}
          >
            Clear
          </button>
        )}
        {filtered.length !== DATA_SOURCES.length && (
          <span className="text-xs text-muted-foreground ml-1">{filtered.length} of {DATA_SOURCES.length} shown</span>
        )}
      </div>

      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground">
              <th className="h-10 w-8 px-4" />
              <th className="h-10 px-4 text-left font-medium">Source</th>
              <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Category</th>
              <th className="h-10 px-4 text-left font-medium hidden sm:table-cell">Tier</th>
              <th className="h-10 px-4 text-left font-medium">Status</th>
              <th className="h-10 px-4 text-left font-medium hidden lg:table-cell">Access</th>
              <th className="h-10 px-4 text-left font-medium hidden xl:table-cell">Cadence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="h-24 text-center text-muted-foreground">
                  No sources match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((src) => {
                const isExpanded = expandedRows.has(src.id);
                return (
                  <>
                    <tr
                      key={src.id}
                      className="border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                      onClick={() => toggleExpand(src.id)}
                      data-testid={`row-source-${src.id}`}
                    >
                      <td className="px-4 py-3 text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{src.name}</div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                          {src.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <Badge variant="outline" className={`text-xs font-semibold ${TIER_BADGE[src.tier]}`}>
                          Tier {src.tier}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={src.status} />
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-xs text-muted-foreground">{src.accessType}</span>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell text-muted-foreground text-xs">
                        {src.refreshCadence}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${src.id}-expanded`} className="border-b last:border-0 bg-muted/20">
                        <td />
                        <td colSpan={6} className="px-4 pb-4 pt-2">
                          <p className="text-sm text-muted-foreground leading-relaxed">{src.description}</p>
                          <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
                            <span><strong>Cadence:</strong> {src.refreshCadence}</span>
                            <span><strong>Access:</strong> {src.accessType}</span>
                            <span><strong>Category:</strong> {src.category}</span>
                            {src.accessType === "Requires Key" && (
                              <span className="text-yellow-700">⚠ API key required in environment config</span>
                            )}
                            {src.accessType === "OAuth" && (
                              <span className="text-blue-600">🔗 OAuth setup required in sub-account settings</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <Database className="h-3.5 w-3.5" />
        Click any row to expand its description. Sources with &quot;Partial&quot; status are active but require additional API key configuration.
      </div>
    </div>
  );
}
