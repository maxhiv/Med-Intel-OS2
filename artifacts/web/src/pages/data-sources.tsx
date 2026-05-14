import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Database, CheckCircle2, AlertTriangle, Clock } from "lucide-react";

type SourceStatus = "Live" | "Partial" | "Pending";

interface DataSource {
  id: string;
  name: string;
  description: string;
  category: string;
  status: SourceStatus;
  requiresKey: boolean;
  refreshCadence: string;
}

const DATA_SOURCES: DataSource[] = [
  {
    id: "clinical_trials",
    name: "ClinicalTrials.gov",
    description: "Active clinical trials for new equipment and procedures at enrolled facilities.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily at 04:30",
  },
  {
    id: "con_filings",
    name: "State CON Filings",
    description: "Certificate-of-Need applications across 22 active CON states — highest-intent equipment signal.",
    category: "State Regulatory",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily at 05:00",
  },
  {
    id: "nppes",
    name: "NPPES / NPI Registry",
    description: "National Provider Identifier registry for facility contact and taxonomy enrichment.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "fda_510k",
    name: "FDA 510(k) Clearances",
    description: "Pre-market notification clearances showing recently approved medical devices.",
    category: "FDA",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily",
  },
  {
    id: "fda_recalls",
    name: "FDA Device Recalls",
    description: "Active equipment recall notices that drive accelerated replacement cycles.",
    category: "FDA",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily",
  },
  {
    id: "fda_maude",
    name: "FDA MAUDE Adverse Events",
    description: "Medical device malfunction and adverse event reports indicating equipment failure patterns.",
    category: "FDA",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily",
  },
  {
    id: "fda_class",
    name: "FDA Device Classification",
    description: "Regulatory device class database used to enrich equipment type signals.",
    category: "FDA",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "propublica_990",
    name: "ProPublica 990 Filings",
    description: "Non-profit hospital 990 filings for capital expenditure and financial health signals.",
    category: "Non-Profit",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "cms_data",
    name: "CMS Open Payments / IPPS",
    description: "Centers for Medicare & Medicaid Services data including cost report and utilization signals.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "sec_edgar",
    name: "SEC EDGAR Filings",
    description: "Public company 10-K and 8-K filings for capex guidance and equipment purchase disclosures.",
    category: "Financial",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily",
  },
  {
    id: "usa_spending",
    name: "USASpending.gov",
    description: "Federal contract and grant award data surfacing government-funded equipment purchases.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Daily",
  },
  {
    id: "sam_gov",
    name: "SAM.gov / FedBizOpps",
    description: "Federal acquisition opportunities and RFPs for medical equipment — requires API key.",
    category: "Federal",
    status: "Partial",
    requiresKey: true,
    refreshCadence: "Daily",
  },
  {
    id: "emma_bonds",
    name: "EMMA Municipal Bonds",
    description: "Municipal bond issuances for hospital capital projects — strong CON corroboration signal.",
    category: "Financial",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "hcris",
    name: "HCRIS Cost Reports",
    description: "Hospital Cost Report Information System — depreciation spikes and asset replacement signals.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Quarterly",
  },
  {
    id: "hrsa",
    name: "HRSA Grant Awards",
    description: "Health Resources & Services Administration grants for facility upgrades and equipment.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "usda",
    name: "USDA Rural Development",
    description: "Rural hospital and clinic grants indicating equipment purchase intent.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Weekly",
  },
  {
    id: "medicare_util",
    name: "Medicare Utilization",
    description: "Procedure-level Medicare utilization data surfacing high-volume equipment demand signals.",
    category: "Federal",
    status: "Live",
    requiresKey: false,
    refreshCadence: "Monthly",
  },
  {
    id: "zerobounce",
    name: "ZeroBounce Email Validation",
    description: "Async email address validation for contact enrichment — requires API key.",
    category: "Enrichment",
    status: "Partial",
    requiresKey: true,
    refreshCadence: "On demand",
  },
  {
    id: "bouncer",
    name: "Bouncer Email Validation",
    description: "Secondary email validation provider — requires API key.",
    category: "Enrichment",
    status: "Partial",
    requiresKey: true,
    refreshCadence: "On demand",
  },
  {
    id: "ghl_crm",
    name: "GoHighLevel CRM",
    description: "Sub-account CRM integration for opportunity creation and outreach task management.",
    category: "CRM",
    status: "Live",
    requiresKey: false,
    refreshCadence: "On push",
  },
  {
    id: "hubspot_crm",
    name: "HubSpot CRM",
    description: "HubSpot OAuth integration for contact sync and deal pipeline management.",
    category: "CRM",
    status: "Pending",
    requiresKey: true,
    refreshCadence: "On push",
  },
  {
    id: "salesforce_crm",
    name: "Salesforce CRM",
    description: "Salesforce OAuth integration for lead and opportunity management.",
    category: "CRM",
    status: "Pending",
    requiresKey: true,
    refreshCadence: "On push",
  },
];

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

const CATEGORIES = Array.from(new Set(DATA_SOURCES.map((s) => s.category)));

const STATUS_COUNTS = {
  Live: DATA_SOURCES.filter((s) => s.status === "Live").length,
  Partial: DATA_SOURCES.filter((s) => s.status === "Partial").length,
  Pending: DATA_SOURCES.filter((s) => s.status === "Pending").length,
};

export default function DataSourcesPage() {
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

      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground">
              <th className="h-10 px-4 text-left font-medium">Source</th>
              <th className="h-10 px-4 text-left font-medium hidden md:table-cell">Category</th>
              <th className="h-10 px-4 text-left font-medium">Status</th>
              <th className="h-10 px-4 text-left font-medium hidden lg:table-cell">Cadence</th>
              <th className="h-10 px-4 text-left font-medium hidden xl:table-cell">Description</th>
            </tr>
          </thead>
          <tbody>
            {DATA_SOURCES.map((src) => (
              <tr key={src.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`row-source-${src.id}`}>
                <td className="p-4">
                  <div className="font-medium">{src.name}</div>
                  {src.requiresKey && (
                    <div className="text-xs text-muted-foreground mt-0.5">Requires API key</div>
                  )}
                </td>
                <td className="p-4 hidden md:table-cell">
                  <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                    {src.category}
                  </span>
                </td>
                <td className="p-4">
                  <StatusBadge status={src.status} />
                </td>
                <td className="p-4 hidden lg:table-cell text-muted-foreground text-xs">
                  {src.refreshCadence}
                </td>
                <td className="p-4 hidden xl:table-cell text-muted-foreground text-xs max-w-xs">
                  {src.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <Database className="h-3.5 w-3.5" />
        Sources with &quot;Partial&quot; status are active but require additional API key configuration in your environment.
      </div>
    </div>
  );
}
