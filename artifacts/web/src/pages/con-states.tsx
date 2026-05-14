import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MapPin, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";

type Tier = "A" | "B" | "C";

interface ConState {
  code: string;
  name: string;
  tier: Tier;
  agency: string;
  threshold: string;
  sunsetDate: string | null;
  portalUrl: string;
  note: string;
}

const CMX_CON_STATES: ConState[] = [
  { code: "IL", name: "Illinois",        tier: "A", agency: "HFSRB",                            threshold: "$100K",  sunsetDate: null,       portalUrl: "https://hfsrb.illinois.gov/",             note: "Highest-volume Tier A market; covers MRI, CT, cath labs." },
  { code: "NY", name: "New York",         tier: "A", agency: "NY DOH",                           threshold: "$15K",   sunsetDate: null,       portalUrl: "https://www.health.ny.gov/facilities/cons/", note: "Strictest review; broad equipment scope including imaging." },
  { code: "CT", name: "Connecticut",      tier: "A", agency: "OHCA",                             threshold: "$1M",    sunsetDate: null,       portalUrl: "https://portal.ct.gov/ohca",              note: "Active review; strong imaging + OR equipment pipeline." },
  { code: "MI", name: "Michigan",         tier: "A", agency: "BCAEO",                            threshold: "$2.1M",  sunsetDate: null,       portalUrl: "https://www.michigan.gov/lara",           note: "Covers major capital equipment; active hospital market." },
  { code: "NC", name: "North Carolina",   tier: "A", agency: "DHSR",                             threshold: "$2M",    sunsetDate: null,       portalUrl: "https://www2.ncdhhs.gov/dhsr/",           note: "Radiology + cardiac equipment heavily reviewed." },
  { code: "MA", name: "Massachusetts",    tier: "A", agency: "DHCFP / DPH",                     threshold: "$1.5M",  sunsetDate: null,       portalUrl: "https://www.mass.gov/orgs/health-policy-commission", note: "High-value filings; strong academic medical market." },
  { code: "MD", name: "Maryland",         tier: "A", agency: "MHCC",                             threshold: "$1M",    sunsetDate: null,       portalUrl: "https://mhcc.maryland.gov/",              note: "Covers all major equipment categories; competitive market." },
  { code: "VA", name: "Virginia",         tier: "A", agency: "VHHA / COPN",                      threshold: "$1.5M",  sunsetDate: null,       portalUrl: "https://www.vdh.virginia.gov/copn/",      note: "Active imaging + surgery center pipeline." },
  { code: "GA", name: "Georgia",          tier: "A", agency: "SHPB",                             threshold: "$2.5M",  sunsetDate: null,       portalUrl: "https://dch.georgia.gov/",                note: "Strong hospital expansion activity; covers MRI/CT." },
  { code: "OH", name: "Ohio",             tier: "A", agency: "Ohio DOH",                         threshold: "$1.5M",  sunsetDate: null,       portalUrl: "https://odh.ohio.gov/",                   note: "Mid-high volume; covers equipment and new services." },
  { code: "MN", name: "Minnesota",        tier: "A", agency: "MDH",                              threshold: "$1M",    sunsetDate: null,       portalUrl: "https://www.health.state.mn.us/",         note: "Regular equipment reviews for imaging + therapy." },
  { code: "FL", name: "Florida",          tier: "B", agency: "AHCA",                             threshold: "$2.6M",  sunsetDate: null,       portalUrl: "https://ahca.myflorida.com/con/",         note: "Large market; imaging and surgery center focus." },
  { code: "TX", name: "Texas",            tier: "B", agency: "HHSC",                             threshold: "$1M",    sunsetDate: null,       portalUrl: "https://www.hhs.texas.gov/",              note: "Selective CON scope; mostly LTAC and ESRD." },
  { code: "CA", name: "California",       tier: "B", agency: "CDPH / HCAI",                      threshold: "$3M",    sunsetDate: null,       portalUrl: "https://hcai.ca.gov/",                    note: "Project-focused rather than equipment; high deal value." },
  { code: "IN", name: "Indiana",          tier: "B", agency: "ISDH",                             threshold: "$1.5M",  sunsetDate: null,       portalUrl: "https://www.in.gov/isdh/",                note: "Covers neonatal, cardiac, transplant services." },
  { code: "WI", name: "Wisconsin",        tier: "B", agency: "DHS",                              threshold: "$750K",  sunsetDate: null,       portalUrl: "https://www.dhs.wisconsin.gov/",          note: "Smaller market; steady imaging pipeline." },
  { code: "KY", name: "Kentucky",         tier: "B", agency: "Cabinet for Health",               threshold: "$600K",  sunsetDate: null,       portalUrl: "https://chfs.ky.gov/",                    note: "Regular imaging + OR equipment reviews." },
  { code: "TN", name: "Tennessee",        tier: "B", agency: "TDH",                              threshold: "$1M",    sunsetDate: null,       portalUrl: "https://www.tn.gov/health/",              note: "Active hospital and ASC market." },
  { code: "WA", name: "Washington",       tier: "B", agency: "DOH",                              threshold: "$3M",    sunsetDate: null,       portalUrl: "https://doh.wa.gov/",                     note: "Covers large capital projects; LTAC + hospital beds." },
  { code: "MO", name: "Missouri",         tier: "B", agency: "DHSS",                             threshold: "$1M",    sunsetDate: null,       portalUrl: "https://health.mo.gov/",                  note: "Focused on facility expansions; moderate volume." },
  { code: "MS", name: "Mississippi",      tier: "C", agency: "State Dept of Health",             threshold: "$500K",  sunsetDate: "2027-07-01", portalUrl: "https://msdh.ms.gov/",                  note: "Sunset provision in discussion; monitor legislative session." },
  { code: "AL", name: "Alabama",          tier: "C", agency: "SHPDA",                            threshold: "$300K",  sunsetDate: null,       portalUrl: "https://www.shpda.alabama.gov/",          note: "Emerging market; lower threshold creates more filings." },
];

const TIER_CONFIG: Record<Tier, { label: string; description: string; badgeClass: string; dotClass: string }> = {
  A: { label: "Tier A", description: "Highest CON activity & deal value",  badgeClass: "bg-red-500/10 text-red-700 border-red-200",    dotClass: "bg-red-500" },
  B: { label: "Tier B", description: "Moderate activity",                  badgeClass: "bg-yellow-500/10 text-yellow-700 border-yellow-200", dotClass: "bg-yellow-500" },
  C: { label: "Tier C", description: "Emerging / lower volume",            badgeClass: "bg-muted text-muted-foreground border-border", dotClass: "bg-gray-400" },
};

function TierBadge({ tier }: { tier: Tier }) {
  const cfg = TIER_CONFIG[tier];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${cfg.badgeClass}`}>
      {cfg.label}
    </span>
  );
}

function StateCard({ state, filingCount }: { state: ConState; filingCount: number }) {
  const hasSunset = !!state.sunsetDate;
  const sunsetNear = hasSunset && new Date(state.sunsetDate!) < new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  return (
    <Link href={`/con-monitor?state=${state.code}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-2xl font-bold font-mono text-primary">{state.code}</div>
              <div className="text-sm text-muted-foreground mt-0.5">{state.name}</div>
            </div>
            <TierBadge tier={state.tier} />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div>
              <span className="text-muted-foreground">Agency</span>
              <div className="font-medium truncate">{state.agency}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Threshold</span>
              <div className="font-medium">{state.threshold}</div>
            </div>
          </div>

          {hasSunset && (
            <div className={`text-xs px-2 py-1 rounded border ${sunsetNear ? "bg-orange-500/10 border-orange-200 text-orange-700" : "bg-muted text-muted-foreground border-border"}`}>
              Sunset: {state.sunsetDate}
              {sunsetNear && " ⚠ Near"}
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1 text-muted-foreground">
              <MapPin className="h-3 w-3" />
              <span>{filingCount} filing{filingCount !== 1 ? "s" : ""}</span>
            </div>
            <a
              href={state.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-0.5 text-primary hover:underline"
            >
              Portal <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <p className="text-xs text-muted-foreground leading-snug line-clamp-2" title={state.note}>
            {state.note}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

type TierFilter = "all" | Tier;

export default function ConStatesPage() {
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [stateCounts, setStateCounts] = useState<Record<string, number>>({});
  const { data: me } = useGetMe();

  useEffect(() => {
    if (!me) return;
    fetch("/api/signals/con-filings/state-counts", { credentials: "include" })
      .then((r) => r.json())
      .then((data: Record<string, number>) => setStateCounts(data))
      .catch(() => {});
  }, [me]);

  const tierA = CMX_CON_STATES.filter((s) => s.tier === "A");
  const tierB = CMX_CON_STATES.filter((s) => s.tier === "B");
  const tierC = CMX_CON_STATES.filter((s) => s.tier === "C");

  const filteredStates =
    tierFilter === "all"
      ? CMX_CON_STATES
      : CMX_CON_STATES.filter((s) => s.tier === tierFilter);

  const filteredA = filteredStates.filter((s) => s.tier === "A");
  const filteredB = filteredStates.filter((s) => s.tier === "B");
  const filteredC = filteredStates.filter((s) => s.tier === "C");

  const totalFilings = CMX_CON_STATES.reduce((acc, s) => acc + (stateCounts[s.code] ?? 0), 0);

  const TABS: { value: TierFilter; label: string; count: number }[] = [
    { value: "all", label: "All States", count: CMX_CON_STATES.length },
    { value: "A",   label: "Tier A",     count: tierA.length },
    { value: "B",   label: "Tier B",     count: tierB.length },
    { value: "C",   label: "Tier C",     count: tierC.length },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CON States</h1>
        <p className="text-muted-foreground">
          CMX coverage across {CMX_CON_STATES.length} active Certificate-of-Need states. Click any state to filter the CON Monitor.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
        <Card className="py-4">
          <div className="text-3xl font-bold text-primary">{CMX_CON_STATES.length}</div>
          <div className="text-xs text-muted-foreground mt-1">States Covered</div>
        </Card>
        <Card className="py-4">
          <div className="text-3xl font-bold text-red-600">{tierA.length}</div>
          <div className="text-xs text-muted-foreground mt-1">Tier A Markets</div>
        </Card>
        <Card className="py-4">
          <div className="text-3xl font-bold text-yellow-700">{tierB.length}</div>
          <div className="text-xs text-muted-foreground mt-1">Tier B Markets</div>
        </Card>
        <Card className="py-4">
          <div className="text-3xl font-bold">{totalFilings.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-1">Total Filings Tracked</div>
        </Card>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setTierFilter(tab.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tierFilter === tab.value
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs opacity-70">({tab.count})</span>
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {filteredA.length > 0 && (
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${TIER_CONFIG.A.dotClass}`} />
              Tier A — {TIER_CONFIG.A.description}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredA.map((s) => (
                <StateCard key={s.code} state={s} filingCount={stateCounts[s.code] ?? 0} />
              ))}
            </div>
          </div>
        )}

        {filteredB.length > 0 && (
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${TIER_CONFIG.B.dotClass}`} />
              Tier B — {TIER_CONFIG.B.description}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredB.map((s) => (
                <StateCard key={s.code} state={s} filingCount={stateCounts[s.code] ?? 0} />
              ))}
            </div>
          </div>
        )}

        {filteredC.length > 0 && (
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${TIER_CONFIG.C.dotClass}`} />
              Tier C — {TIER_CONFIG.C.description}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredC.map((s) => (
                <StateCard key={s.code} state={s} filingCount={stateCounts[s.code] ?? 0} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5" />
        Tier assignments reflect CON application volume and equipment-purchase activity across CMX&apos;s target markets. Filing counts update daily.
      </div>
    </div>
  );
}
