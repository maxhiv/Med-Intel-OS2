/**
 * Territory filter panel — controlled component that owns the filter shape
 * and emits onChange. The page parents it and decides when to preview.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";
import type { TerritoryFilter, ViewKind } from "@/hooks/use-territory";
import type { EquipmentLineProfile } from "@/hooks/use-territory";

interface Props {
  filter: TerritoryFilter;
  viewKind: ViewKind;
  equipmentLineSlug?: string;
  equipmentLines: EquipmentLineProfile[];
  onChange: (next: TerritoryFilter) => void;
  onViewKindChange: (next: ViewKind) => void;
  onEquipmentLineChange: (slug: string | undefined) => void;
}

const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR",
];

const FACILITY_TYPES = [
  "Hospital",
  "Critical Access Hospital",
  "Ambulatory Surgery Center",
  "Imaging Center",
  "Cancer Center",
  "Dialysis Center",
  "FQHC",
  "RHC",
  "Long-Term Care Hospital",
  "Inpatient Rehabilitation Facility",
  "Psychiatric Hospital",
  "Skilled Nursing Facility",
];

function StatePicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase().slice(0, 2))}
          placeholder="e.g. IL"
          className="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (input.length === 2 && ALL_STATES.includes(input) && !selected.includes(input)) {
              onChange([...selected, input]);
              setInput("");
            }
          }}
        >
          Add
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {selected.map((s) => (
          <Badge key={s} variant="outline" className="cursor-pointer" onClick={() => onChange(selected.filter((x) => x !== s))}>
            {s} <X className="h-3 w-3 ml-1" />
          </Badge>
        ))}
      </div>
    </div>
  );
}

function MultiChipPicker({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => {
        const active = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(active ? selected.filter((x) => x !== opt) : [...selected, opt])}
            className={
              "text-xs rounded-full border px-2 py-1 " +
              (active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted")
            }
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

export function TerritoryFilterPanel({
  filter,
  viewKind,
  equipmentLineSlug,
  equipmentLines,
  onChange,
  onViewKindChange,
  onEquipmentLineChange,
}: Props) {
  const update = (patch: Partial<TerritoryFilter>) => onChange({ ...filter, ...patch });
  const updateOwnership = (patch: Partial<NonNullable<TerritoryFilter["ownership"]>>) =>
    onChange({ ...filter, ownership: { ...filter.ownership, ...patch } });
  const updateFinancial = (patch: Partial<NonNullable<TerritoryFilter["financialSize"]>>) =>
    onChange({ ...filter, financialSize: { ...filter.financialSize, ...patch } });
  const updateCycle = (patch: Partial<NonNullable<TerritoryFilter["cycle"]>>) =>
    onChange({ ...filter, cycle: { ...filter.cycle, ...patch } });
  const updateSellSide = (patch: Partial<NonNullable<TerritoryFilter["sellSide"]>>) =>
    onChange({ ...filter, sellSide: { ...filter.sellSide, ...patch } });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">View & line</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">View kind</Label>
            <Select value={viewKind} onValueChange={(v) => onViewKindChange(v as ViewKind)}>
              <SelectTrigger className="h-8 mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="buy_side">Buy-side (capital prospects)</SelectItem>
                <SelectItem value="sell_side">Sell-side (distress / divest)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Equipment line</Label>
            <Select
              value={equipmentLineSlug ?? "__none__"}
              onValueChange={(v) => onEquipmentLineChange(v === "__none__" ? undefined : v)}
            >
              <SelectTrigger className="h-8 mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No line lens (base score)</SelectItem>
                {equipmentLines.map((l) => (
                  <SelectItem key={l.slug} value={l.slug}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Geography</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">States</Label>
            <StatePicker
              selected={filter.states ?? []}
              onChange={(states) => update({ states: states.length > 0 ? states : undefined })}
            />
          </div>
          <div>
            <Label className="text-xs">ZIP codes (comma-separated)</Label>
            <Input
              className="h-8 mt-1"
              value={(filter.zips ?? []).join(", ")}
              onChange={(e) => {
                const zips = e.target.value
                  .split(/[,\s]+/)
                  .map((z) => z.trim())
                  .filter((z) => z.length >= 3 && z.length <= 10);
                update({ zips: zips.length > 0 ? zips : undefined });
              }}
              placeholder="60601, 60611, …"
            />
          </div>
          <div>
            <Label className="text-xs">Search by facility name</Label>
            <Input
              className="h-8 mt-1"
              value={filter.search ?? ""}
              onChange={(e) => update({ search: e.target.value || undefined })}
              placeholder="e.g. Northwestern"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Facility type</CardTitle></CardHeader>
        <CardContent>
          <MultiChipPicker
            options={FACILITY_TYPES}
            selected={filter.facilityTypes ?? []}
            onChange={(types) => update({ facilityTypes: types.length > 0 ? types : undefined })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Ownership profile</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {[
            ["privateEquity", "PE-backed"],
            ["reit", "REIT"],
            ["chain", "Chain / multi-facility"],
            ["holdingCompany", "Holding company"],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={Boolean(filter.ownership?.[k as keyof NonNullable<TerritoryFilter["ownership"]>])}
                onCheckedChange={(v) => updateOwnership({ [k]: Boolean(v) } as never)}
              />
              {label}
            </label>
          ))}
          <div>
            <Label className="text-xs">For-profit</Label>
            <Select
              value={String(filter.ownership?.forProfit ?? "any")}
              onValueChange={(v) =>
                updateOwnership({
                  forProfit: v === "any" ? undefined : v === "true" ? true : v === "false" ? false : undefined,
                })
              }
            >
              <SelectTrigger className="h-8 mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="true">For-profit only</SelectItem>
                <SelectItem value="false">Non-profit only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Financial size (HCRIS)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div>
            <Label className="text-xs">Min beds</Label>
            <Input type="number" className="h-8 mt-1" value={filter.financialSize?.minBeds ?? ""}
              onChange={(e) => updateFinancial({ minBeds: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </div>
          <div>
            <Label className="text-xs">Min total assets ($)</Label>
            <Input type="number" className="h-8 mt-1" value={filter.financialSize?.minTotalAssets ?? ""}
              onChange={(e) => updateFinancial({ minTotalAssets: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </div>
          <div>
            <Label className="text-xs">Min net patient revenue ($)</Label>
            <Input type="number" className="h-8 mt-1" value={filter.financialSize?.minNetPatientRevenue ?? ""}
              onChange={(e) => updateFinancial({ minNetPatientRevenue: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Buying-cycle indicators</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {[
            ["recentChow", "Recent CHOW (last 18 mo)"],
            ["aipInfraSpend", "AIP infrastructure spend"],
            ["cmmiStateLaunch", "CMMI model in state"],
            ["psi11Outlier", "PSI-11 outlier"],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={Boolean(filter.cycle?.[k as keyof NonNullable<TerritoryFilter["cycle"]>])}
                onCheckedChange={(v) => updateCycle({ [k]: Boolean(v) } as never)}
              />
              {label}
            </label>
          ))}
        </CardContent>
      </Card>

      {viewKind === "sell_side" ? (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Sell-side filters</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {[
              ["sellerSideChow", "Appears as CHOW seller"],
              ["hcrisNetIncomeYoyDecline", "Net income YoY decline"],
              ["hcrisCashYoyDecline", "Cash on hand YoY decline"],
              ["acquisitionsInMetro", "Active acquisition market (CBSA)"],
            ].map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={Boolean(filter.sellSide?.[k as keyof NonNullable<TerritoryFilter["sellSide"]>])}
                  onCheckedChange={(v) => updateSellSide({ [k]: Boolean(v) } as never)}
                />
                {label}
              </label>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Score</CardTitle></CardHeader>
        <CardContent>
          <Label className="text-xs">Minimum score</Label>
          <Input
            type="number"
            min={0}
            max={100}
            className="h-8 mt-1"
            value={filter.scoreMin ?? ""}
            onChange={(e) => update({ scoreMin: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </CardContent>
      </Card>
    </div>
  );
}
