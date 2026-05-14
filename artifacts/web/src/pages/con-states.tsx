import { useListConFilings } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MapPin } from "lucide-react";
import { Link } from "wouter";

const CMX_CON_STATES = [
  { code: "AL", name: "Alabama", tier: 2 },
  { code: "CA", name: "California", tier: 1 },
  { code: "CT", name: "Connecticut", tier: 1 },
  { code: "FL", name: "Florida", tier: 1 },
  { code: "GA", name: "Georgia", tier: 1 },
  { code: "IL", name: "Illinois", tier: 1 },
  { code: "IN", name: "Indiana", tier: 2 },
  { code: "KY", name: "Kentucky", tier: 2 },
  { code: "MA", name: "Massachusetts", tier: 1 },
  { code: "MD", name: "Maryland", tier: 1 },
  { code: "MI", name: "Michigan", tier: 1 },
  { code: "MN", name: "Minnesota", tier: 2 },
  { code: "MO", name: "Missouri", tier: 2 },
  { code: "MS", name: "Mississippi", tier: 3 },
  { code: "NC", name: "North Carolina", tier: 1 },
  { code: "NY", name: "New York", tier: 1 },
  { code: "OH", name: "Ohio", tier: 1 },
  { code: "TN", name: "Tennessee", tier: 2 },
  { code: "TX", name: "Texas", tier: 1 },
  { code: "VA", name: "Virginia", tier: 1 },
  { code: "WA", name: "Washington", tier: 2 },
  { code: "WI", name: "Wisconsin", tier: 2 },
] as const;

const TIER_CONFIG = {
  1: { label: "Tier 1", description: "High CON activity", className: "bg-red-500/10 text-red-600 border-red-200" },
  2: { label: "Tier 2", description: "Moderate activity", className: "bg-yellow-500/10 text-yellow-700 border-yellow-200" },
  3: { label: "Tier 3", description: "Lower activity", className: "bg-muted text-muted-foreground border-border" },
};

function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cfg = TIER_CONFIG[tier];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

function StateCard({ code, name, tier, filingCount }: { code: string; name: string; tier: 1 | 2 | 3; filingCount: number }) {
  const cfg = TIER_CONFIG[tier];
  return (
    <Link href={`/con-monitor?state=${code}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-2xl font-bold font-mono text-primary">{code}</div>
              <div className="text-sm text-muted-foreground mt-0.5">{name}</div>
            </div>
            <TierBadge tier={tier} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">{cfg.description}</div>
            <div className="flex items-center gap-1 text-sm font-medium">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{filingCount} filing{filingCount !== 1 ? "s" : ""} tracked</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function ConStatesPage() {
  const { data } = useListConFilings({ limit: 1 });
  const states = data?.states ?? [];
  const stateFilingMap = new Map<string, number>();
  for (const s of states) {
    stateFilingMap.set(s, 0);
  }

  const tier1 = CMX_CON_STATES.filter((s) => s.tier === 1);
  const tier2 = CMX_CON_STATES.filter((s) => s.tier === 2);
  const tier3 = CMX_CON_STATES.filter((s) => s.tier === 3);

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
          <div className="text-3xl font-bold text-red-600">{tier1.length}</div>
          <div className="text-xs text-muted-foreground mt-1">Tier 1 Markets</div>
        </Card>
        <Card className="py-4">
          <div className="text-3xl font-bold text-yellow-700">{tier2.length}</div>
          <div className="text-xs text-muted-foreground mt-1">Tier 2 Markets</div>
        </Card>
        <Card className="py-4">
          <div className="text-3xl font-bold text-muted-foreground">{tier3.length}</div>
          <div className="text-xs text-muted-foreground mt-1">Tier 3 Markets</div>
        </Card>
      </div>

      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <span className="inline-block w-3 h-3 rounded-full bg-red-500"></span>
            Tier 1 — High CON Activity
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {tier1.map((s) => (
              <StateCard key={s.code} {...s} filingCount={stateFilingMap.get(s.code) ?? 0} />
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <span className="inline-block w-3 h-3 rounded-full bg-yellow-500"></span>
            Tier 2 — Moderate Activity
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {tier2.map((s) => (
              <StateCard key={s.code} {...s} filingCount={stateFilingMap.get(s.code) ?? 0} />
            ))}
          </div>
        </div>

        {tier3.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
              <span className="inline-block w-3 h-3 rounded-full bg-gray-400"></span>
              Tier 3 — Emerging Markets
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {tier3.map((s) => (
                <StateCard key={s.code} {...s} filingCount={stateFilingMap.get(s.code) ?? 0} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5" />
        Tier assignments reflect typical CON application volume and equipment-purchase activity across CMX&apos;s target markets.
      </div>
    </div>
  );
}
