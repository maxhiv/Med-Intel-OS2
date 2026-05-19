/**
 * Equipment-line targeting profiles.
 *
 * A "profile" is a JSON rubric that re-ranks territory results for a specific
 * capital-equipment category — imaging is interested in different signals
 * than sterilization is. Each profile is a bundle of:
 *   - facilityTypeWeights:  multiplier per facility_type
 *   - hcrisRequirements:    must-meet thresholds (e.g. ≥100 beds for CT)
 *   - hcrisBoosts:          per-dollar score nudges (e.g. outpatient revenue)
 *   - signalBoosts:         per-flag bumps (chow_recent worth more for imaging)
 *
 * The six seeded system profiles below cover ChicagoMedEx's lines. Account
 * admins can clone-and-edit via the API to add custom rubrics.
 */
import { sql, eq, and, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  type Facility,
  equipmentLineProfiles,
  type EquipmentLineProfile,
} from "@workspace/db";

export const equipmentLineRubricSchema = z.object({
  facilityTypeWeights: z.record(z.string(), z.number()).default({}),
  hcrisRequirements: z
    .object({
      minBeds: z.number().int().nonnegative().optional(),
      minOutpatientRevenue: z.number().nonnegative().optional(),
      minTotalDischarges: z.number().int().nonnegative().optional(),
    })
    .default({}),
  hcrisBoosts: z
    .object({
      perThousandDischarges: z.number().default(0),
      perMillionOutpatientRevenue: z.number().default(0),
      perMillionInpatientRevenue: z.number().default(0),
      perBed: z.number().default(0),
    })
    .default(() => ({
      perThousandDischarges: 0,
      perMillionOutpatientRevenue: 0,
      perMillionInpatientRevenue: 0,
      perBed: 0,
    })),
  signalBoosts: z
    .object({
      recentChow: z.number().default(0),
      privateEquity: z.number().default(0),
      reit: z.number().default(0),
      aipInfraSpend: z.number().default(0),
      chain: z.number().default(0),
      sellerSideChow: z.number().default(0),
      hcrisNetIncomeYoyDecline: z.number().default(0),
    })
    .default(() => ({
      recentChow: 0,
      privateEquity: 0,
      reit: 0,
      aipInfraSpend: 0,
      chain: 0,
      sellerSideChow: 0,
      hcrisNetIncomeYoyDecline: 0,
    })),
  /** Max score this rubric is allowed to add on top of base. Cap at 100. */
  scoreCeiling: z.number().min(0).max(200).default(120),
});
export type EquipmentLineRubric = z.infer<typeof equipmentLineRubricSchema>;

// ─── Six seed rubrics ────────────────────────────────────────────────────────

export const SYSTEM_EQUIPMENT_LINE_PROFILES: Array<{
  slug: string;
  name: string;
  description: string;
  rubric: EquipmentLineRubric;
}> = [
  {
    slug: "imaging",
    name: "Imaging (CT / MRI / X-ray / Ultrasound / Fluoroscopy)",
    description:
      "Higher fit for outpatient-heavy hospitals and imaging centers with discharge volume and capital headroom.",
    rubric: {
      facilityTypeWeights: {
        Hospital: 1.0,
        "Critical Access Hospital": 0.7,
        "Imaging Center": 1.2,
        "Cancer Center": 1.0,
        "Ambulatory Surgery Center": 0.5,
      },
      hcrisRequirements: { minBeds: 50, minTotalDischarges: 1000 },
      hcrisBoosts: { perMillionOutpatientRevenue: 0.4, perThousandDischarges: 1.2, perBed: 0.05, perMillionInpatientRevenue: 0 },
      signalBoosts: {
        recentChow: 12,
        privateEquity: 10,
        reit: 6,
        aipInfraSpend: 14,
        chain: 4,
        sellerSideChow: 0,
        hcrisNetIncomeYoyDecline: 0,
      },
      scoreCeiling: 120,
    },
  },
  {
    slug: "surgical",
    name: "Surgical (OR tables / lights / anesthesia / electrosurgery)",
    description: "Targets hospitals and ASCs with strong surgical case volume.",
    rubric: {
      facilityTypeWeights: {
        Hospital: 1.0,
        "Ambulatory Surgery Center": 1.3,
        "Critical Access Hospital": 0.6,
      },
      hcrisRequirements: { minBeds: 30 },
      hcrisBoosts: { perThousandDischarges: 2.0, perBed: 0.08, perMillionInpatientRevenue: 0.3, perMillionOutpatientRevenue: 0.1 },
      signalBoosts: {
        recentChow: 10,
        privateEquity: 12,
        reit: 6,
        aipInfraSpend: 10,
        chain: 5,
        sellerSideChow: 0,
        hcrisNetIncomeYoyDecline: 0,
      },
      scoreCeiling: 115,
    },
  },
  {
    slug: "monitoring",
    name: "Patient Monitoring (vitals / telemetry / cardiac)",
    description:
      "Beds + ICU intensity drive volume. PSI-11 outliers flag respiratory-monitoring opportunities.",
    rubric: {
      facilityTypeWeights: { Hospital: 1.0, "Critical Access Hospital": 0.9 },
      hcrisRequirements: { minBeds: 25 },
      hcrisBoosts: { perBed: 0.18, perMillionInpatientRevenue: 0.2, perThousandDischarges: 0.6, perMillionOutpatientRevenue: 0 },
      signalBoosts: {
        recentChow: 6,
        privateEquity: 8,
        reit: 4,
        aipInfraSpend: 8,
        chain: 3,
        sellerSideChow: 0,
        hcrisNetIncomeYoyDecline: 0,
      },
      scoreCeiling: 110,
    },
  },
  {
    slug: "sterilization",
    name: "Sterilization & CSPD (sterilizers / washers / endoscope reprocessors)",
    description: "Volume-driven; favors larger acute facilities and ASCs.",
    rubric: {
      facilityTypeWeights: { Hospital: 1.0, "Ambulatory Surgery Center": 1.2, "Critical Access Hospital": 0.6 },
      hcrisRequirements: { minBeds: 25, minTotalDischarges: 500 },
      hcrisBoosts: { perThousandDischarges: 1.5, perBed: 0.08, perMillionInpatientRevenue: 0.15, perMillionOutpatientRevenue: 0.1 },
      signalBoosts: {
        recentChow: 8,
        privateEquity: 8,
        reit: 4,
        aipInfraSpend: 12,
        chain: 4,
        sellerSideChow: 0,
        hcrisNetIncomeYoyDecline: 0,
      },
      scoreCeiling: 110,
    },
  },
  {
    slug: "endoscopy",
    name: "Endoscopy (GI / pulmonary / urology scopes + towers)",
    description: "Outpatient-heavy mix; ASCs and outpatient suites win this lane.",
    rubric: {
      facilityTypeWeights: { Hospital: 0.9, "Ambulatory Surgery Center": 1.3, "Cancer Center": 0.8 },
      hcrisRequirements: { minTotalDischarges: 300 },
      hcrisBoosts: { perMillionOutpatientRevenue: 0.6, perThousandDischarges: 1.0, perBed: 0.04, perMillionInpatientRevenue: 0 },
      signalBoosts: {
        recentChow: 8,
        privateEquity: 10,
        reit: 4,
        aipInfraSpend: 10,
        chain: 4,
        sellerSideChow: 0,
        hcrisNetIncomeYoyDecline: 0,
      },
      scoreCeiling: 110,
    },
  },
  {
    slug: "lab",
    name: "Lab (chemistry / hematology / immunoassay / micro)",
    description:
      "Patient volume + program participation (ACO / CMMI) drive labs the most.",
    rubric: {
      facilityTypeWeights: { Hospital: 1.0, "Critical Access Hospital": 0.6, FQHC: 0.7, RHC: 0.5 },
      hcrisRequirements: { minTotalDischarges: 1000 },
      hcrisBoosts: { perThousandDischarges: 1.4, perMillionOutpatientRevenue: 0.3, perBed: 0.05, perMillionInpatientRevenue: 0.1 },
      signalBoosts: {
        recentChow: 6,
        privateEquity: 6,
        reit: 3,
        aipInfraSpend: 10,
        chain: 4,
        sellerSideChow: 0,
        hcrisNetIncomeYoyDecline: 0,
      },
      scoreCeiling: 105,
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

interface ApplyArgs {
  facility: Pick<Facility, "id" | "facilityType" | "signalScore">;
  flags: {
    privateEquity: boolean;
    reit: boolean;
    chain: boolean;
    holdingCompany: boolean;
    recentChow: boolean;
    aipInfraSpend: boolean;
    sellerSideChow?: boolean;
    hcrisNetIncomeYoyDecline?: boolean;
  };
  hcris: {
    numberOfBeds: number | null;
    netPatientRevenue: number | null;
    outpatientRevenue: number | null;
    inpatientRevenue: number | null;
    totalDischargesAll: number | null;
  } | null;
}

export function applyEquipmentLineRubric(
  rubric: EquipmentLineRubric,
  { facility, flags, hcris }: ApplyArgs,
): { score: number; rationale: string[] } {
  const rationale: string[] = [];
  // Hard requirements: if missing, equipment score is the lowest possible.
  const req = rubric.hcrisRequirements;
  if (req.minBeds != null && (hcris?.numberOfBeds == null || hcris.numberOfBeds < req.minBeds)) {
    rationale.push(`Below bed-count threshold (≥${req.minBeds} required)`);
    return { score: 0, rationale };
  }
  if (
    req.minTotalDischarges != null &&
    (hcris?.totalDischargesAll == null || hcris.totalDischargesAll < req.minTotalDischarges)
  ) {
    rationale.push(`Below discharge threshold (≥${req.minTotalDischarges})`);
    return { score: 0, rationale };
  }
  if (
    req.minOutpatientRevenue != null &&
    (hcris?.outpatientRevenue == null || hcris.outpatientRevenue < req.minOutpatientRevenue)
  ) {
    rationale.push(`Below outpatient-revenue threshold`);
    return { score: 0, rationale };
  }

  const typeWeight = rubric.facilityTypeWeights[facility.facilityType] ?? 0.8;
  let score = (facility.signalScore ?? 0) * typeWeight;
  if (typeWeight !== 1.0) rationale.push(`Facility-type weight ${typeWeight.toFixed(2)} (${facility.facilityType})`);

  // HCRIS-driven nudges
  if (hcris) {
    const bumps: Array<[string, number]> = [];
    if (rubric.hcrisBoosts.perBed && hcris.numberOfBeds) {
      bumps.push([`${hcris.numberOfBeds} beds × ${rubric.hcrisBoosts.perBed}`, hcris.numberOfBeds * rubric.hcrisBoosts.perBed]);
    }
    if (rubric.hcrisBoosts.perThousandDischarges && hcris.totalDischargesAll) {
      const v = (hcris.totalDischargesAll / 1_000) * rubric.hcrisBoosts.perThousandDischarges;
      bumps.push([`Discharge volume +${v.toFixed(1)}`, v]);
    }
    if (rubric.hcrisBoosts.perMillionOutpatientRevenue && hcris.outpatientRevenue) {
      const v = (hcris.outpatientRevenue / 1_000_000) * rubric.hcrisBoosts.perMillionOutpatientRevenue;
      bumps.push([`Outpatient revenue +${v.toFixed(1)}`, v]);
    }
    if (rubric.hcrisBoosts.perMillionInpatientRevenue && hcris.inpatientRevenue) {
      const v = (hcris.inpatientRevenue / 1_000_000) * rubric.hcrisBoosts.perMillionInpatientRevenue;
      bumps.push([`Inpatient revenue +${v.toFixed(1)}`, v]);
    }
    for (const [label, val] of bumps) {
      score += val;
      if (Math.abs(val) >= 1) rationale.push(label);
    }
  }

  // Signal-driven nudges
  if (flags.recentChow && rubric.signalBoosts.recentChow) {
    score += rubric.signalBoosts.recentChow;
    rationale.push(`Recent CHOW +${rubric.signalBoosts.recentChow}`);
  }
  if (flags.privateEquity && rubric.signalBoosts.privateEquity) {
    score += rubric.signalBoosts.privateEquity;
    rationale.push(`PE-backed +${rubric.signalBoosts.privateEquity}`);
  }
  if (flags.reit && rubric.signalBoosts.reit) {
    score += rubric.signalBoosts.reit;
    rationale.push(`REIT-owned +${rubric.signalBoosts.reit}`);
  }
  if (flags.aipInfraSpend && rubric.signalBoosts.aipInfraSpend) {
    score += rubric.signalBoosts.aipInfraSpend;
    rationale.push(`AIP infra spend +${rubric.signalBoosts.aipInfraSpend}`);
  }
  if (flags.chain && rubric.signalBoosts.chain) {
    score += rubric.signalBoosts.chain;
    rationale.push(`Chain-owned +${rubric.signalBoosts.chain}`);
  }
  if (flags.sellerSideChow && rubric.signalBoosts.sellerSideChow) {
    score += rubric.signalBoosts.sellerSideChow;
    rationale.push(`Seller-side CHOW +${rubric.signalBoosts.sellerSideChow}`);
  }
  if (flags.hcrisNetIncomeYoyDecline && rubric.signalBoosts.hcrisNetIncomeYoyDecline) {
    score += rubric.signalBoosts.hcrisNetIncomeYoyDecline;
    rationale.push(`Net-income decline +${rubric.signalBoosts.hcrisNetIncomeYoyDecline}`);
  }

  // Ceiling
  if (score > rubric.scoreCeiling) {
    rationale.push(`Capped at ${rubric.scoreCeiling}`);
    score = rubric.scoreCeiling;
  }
  return { score: Math.max(0, Math.round(score)), rationale };
}

// ─── Profile CRUD ───────────────────────────────────────────────────────────

/**
 * Ensures the six system profiles exist in the DB. Called at server startup;
 * idempotent — re-runs replace rubric definitions to keep weights tunable
 * without a deploy if needed.
 */
export async function seedSystemEquipmentLineProfiles(): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (const seed of SYSTEM_EQUIPMENT_LINE_PROFILES) {
    const existing = await db
      .select()
      .from(equipmentLineProfiles)
      .where(and(eq(equipmentLineProfiles.slug, seed.slug), eq(equipmentLineProfiles.isSystem, true)))
      .limit(1);
    if (existing[0]) {
      await db
        .update(equipmentLineProfiles)
        .set({ name: seed.name, description: seed.description, rubric: seed.rubric, updatedAt: new Date() })
        .where(eq(equipmentLineProfiles.id, existing[0].id));
      updated++;
    } else {
      await db.insert(equipmentLineProfiles).values({
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        rubric: seed.rubric,
        isSystem: true,
      });
      inserted++;
    }
  }
  return { inserted, updated };
}

export async function listEquipmentLineProfilesForAccount(
  accountId: string,
): Promise<EquipmentLineProfile[]> {
  return await db
    .select()
    .from(equipmentLineProfiles)
    .where(
      or(
        eq(equipmentLineProfiles.isSystem, true),
        eq(equipmentLineProfiles.accountId, accountId),
      ),
    );
}

export async function getEquipmentLineProfile(
  accountId: string,
  slug: string,
): Promise<EquipmentLineProfile | null> {
  // Account-customised version takes precedence over system default.
  const custom = await db
    .select()
    .from(equipmentLineProfiles)
    .where(and(eq(equipmentLineProfiles.accountId, accountId), eq(equipmentLineProfiles.slug, slug)))
    .limit(1);
  if (custom[0]) return custom[0];
  const system = await db
    .select()
    .from(equipmentLineProfiles)
    .where(and(isNull(equipmentLineProfiles.accountId), eq(equipmentLineProfiles.slug, slug), eq(equipmentLineProfiles.isSystem, true)))
    .limit(1);
  return system[0] ?? null;
}

// Silence unused — kept for downstream filter-by-tag features.
void sql;
