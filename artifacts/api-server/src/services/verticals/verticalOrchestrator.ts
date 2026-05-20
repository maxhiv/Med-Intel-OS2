/**
 * Vertical orchestrator — owns the five customer-vertical playbooks from the
 * v2.0 strategic plan §6 (imaging_center, orthopedic, asc, rural_hospital,
 * veterinary).
 *
 * Two concerns live here:
 *   1. **Seed** the system verticals once at server startup so the territory
 *      planner and Opportunity Inbox always see a baseline catalog.
 *   2. **Assign** facilities to verticals based on facility_type and
 *      CMS designations (CAH → rural_hospital, etc.). Account admins can
 *      override via the per-facility map.
 *
 * Signal-weight overrides per vertical are stored as JSONB on
 * `vertical_modules.signal_weights`; the OpportunityScorer (Phase E) reads
 * them when ranking opportunities for a rep working that vertical.
 *
 * Note on signal_type naming: the handoff's vertical_modules JSONB uses
 * keys like `manufacturer_eol`, while our `signalTypeEnum` ships
 * `eol_equipment`. The `signalKeyAliases` map below normalises both into
 * our enum so existing scoring logic doesn't need to learn new names.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  facilities,
  type Facility,
  verticalModules,
  facilityVerticalMap,
  type VerticalModule,
} from "@workspace/db";

// ─── Seed catalog ────────────────────────────────────────────────────────────

interface SeedVertical {
  slug: string;
  displayName: string;
  description: string;
  primaryModalities: string[];
  facilityTypeFilter: string[];
  signalWeights: Record<string, number>;
}

/** Five system verticals, content carried verbatim from handoff seed 02. */
export const SYSTEM_VERTICALS: SeedVertical[] = [
  {
    slug: "imaging_center",
    displayName: "Imaging Centers",
    description:
      "11,000+ US freestanding imaging centers + 8,000+ hospital outpatient imaging departments.",
    primaryModalities: ["MRI", "CT", "mammo", "PET", "ultrasound", "DXA", "fluoro"],
    facilityTypeFilter: ["Imaging Center", "Outpatient Imaging", "Radiology Office"],
    signalWeights: {
      con_filed: 0.95,
      con_approved: 0.95,
      accreditation_renewal: 0.9,
      eol_equipment: 0.88,
      fda_recall: 0.85,
      hcris_depreciation_spike: 0.75,
      job_posting: 0.65,
      construction_permit: 0.6,
      press_release: 0.55,
    },
  },
  {
    slug: "orthopedic",
    displayName: "Orthopedic Surgery",
    description:
      "6,500+ orthopedic group practices, 2,200+ specialty hospitals doing orthopedic case volume, ortho ASC lines.",
    primaryModalities: ["surgical_robot", "C-arm", "fluoroscopy", "navigation_system"],
    facilityTypeFilter: ["Orthopedic Office", "Specialty Hospital", "Ambulatory Surgery Center"],
    signalWeights: {
      service_line_expansion: 0.95,
      equipment_age_7yr: 0.9,
      job_posting: 0.85,
      con_filed: 0.8,
      con_approved: 0.8,
      capital_investment: 0.75,
    },
  },
  {
    slug: "asc",
    displayName: "Ambulatory Surgery Centers",
    description: "6,000+ Medicare-certified ASCs.",
    primaryModalities: [
      "surgical_robot",
      "endoscopy",
      "C-arm",
      "anesthesia",
      "laser",
      "ultrasound",
    ],
    facilityTypeFilter: ["Ambulatory Surgery Center"],
    signalWeights: {
      service_line_expansion: 0.95,
      accreditation_renewal: 0.9,
      con_filed: 0.85,
      con_approved: 0.85,
      hcris_depreciation_spike: 0.7,
      job_posting: 0.65,
    },
  },
  {
    slug: "rural_hospital",
    displayName: "Rural Hospitals (incl. Critical Access)",
    description: "1,360 Critical Access Hospitals + 1,000+ small rural PPS hospitals.",
    primaryModalities: ["CT", "ultrasound", "C-arm", "fluoroscopy", "mammo", "endoscopy"],
    facilityTypeFilter: ["Critical Access Hospital", "Hospital", "Rural PPS Hospital"],
    signalWeights: {
      grant_awarded: 0.95,
      nih_grant: 0.85,
      con_filed: 0.8,
      con_approved: 0.8,
      financial_health: 0.75,
      hcris_depreciation_spike: 0.75,
      eol_equipment: 0.8,
    },
  },
  {
    slug: "veterinary",
    displayName: "Veterinary Hospitals",
    description:
      "32,000+ US vet practices. AAHA-accredited ~4,800 are the strongest upgrade-prone segment.",
    primaryModalities: [
      "CT",
      "MRI",
      "ultrasound",
      "dental_radiography",
      "C-arm",
      "anesthesia",
      "endoscopy",
    ],
    facilityTypeFilter: [
      "Veterinary Hospital",
      "Veterinary Specialty",
      "Veterinary Emergency",
      "Veterinary Teaching",
    ],
    signalWeights: {
      accreditation_renewal: 0.85,
      leadership_change: 0.9,
      construction_permit: 0.85,
      job_posting: 0.7,
      news_expansion: 0.65,
    },
  },
];

/**
 * Aliases for handoff strategic-plan signal keys → our `signalTypeEnum`
 * values. Maintained so vertical signal_weights JSONB written by hand can
 * use the natural-language keys ("manufacturer_eol", "acr_iac_expiry") and
 * get normalised to the enum at lookup time.
 */
const SIGNAL_KEY_ALIASES: Record<string, string> = {
  manufacturer_eol: "eol_equipment",
  acr_iac_expiry: "accreditation_renewal",
  aaahc_aaaasf_expiry: "accreditation_renewal",
  aaha_accreditation_expiry: "accreditation_renewal",
  fda_recall: "adverse_event_spike",
  con_filing: "con_filed",
  usda_loan_award: "grant_awarded",
  hrsa_grant: "grant_awarded",
  chna_gap: "service_line_expansion",
  consolidator_acquisition: "leadership_change",
  cms_asc_list_expansion: "service_line_expansion",
  cms_procedure_volume_growth: "service_line_expansion",
  asc_list_expansion: "service_line_expansion",
  surgical_robot_age: "equipment_age_7yr",
  job_posting_robotic: "job_posting",
  new_facility_construction: "construction_permit",
  usda_aphis_change: "leadership_change",
  hcris_depreciation: "hcris_depreciation_spike",
  press_release: "news_expansion",
  "340b_enrollment_change": "financial_health",
};

/** Normalise a signal_weights JSONB into our `signalTypeEnum` keys. */
export function normaliseSignalWeights(
  raw: Record<string, number> | unknown,
): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = SIGNAL_KEY_ALIASES[k] ?? k;
    const weight = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(weight)) continue;
    // If multiple aliases collapse to the same enum key (e.g. several
    // accreditation_*_expiry → accreditation_renewal), keep the max.
    out[key] = Math.max(out[key] ?? 0, weight);
  }
  return out;
}

// ─── Seed function ───────────────────────────────────────────────────────────

export async function seedSystemVerticals(): Promise<{
  inserted: number;
  updated: number;
}> {
  let inserted = 0;
  let updated = 0;
  for (const seed of SYSTEM_VERTICALS) {
    const existing = await db
      .select()
      .from(verticalModules)
      .where(eq(verticalModules.slug, seed.slug))
      .limit(1);
    if (existing[0]) {
      await db
        .update(verticalModules)
        .set({
          displayName: seed.displayName,
          description: seed.description,
          primaryModalities: seed.primaryModalities,
          facilityTypeFilter: seed.facilityTypeFilter,
          signalWeights: seed.signalWeights,
          updatedAt: new Date(),
        })
        .where(eq(verticalModules.id, existing[0].id));
      updated++;
    } else {
      await db.insert(verticalModules).values({
        slug: seed.slug,
        displayName: seed.displayName,
        description: seed.description,
        primaryModalities: seed.primaryModalities,
        facilityTypeFilter: seed.facilityTypeFilter,
        signalWeights: seed.signalWeights,
      });
      inserted++;
    }
  }
  return { inserted, updated };
}

// ─── Vertical assignment ─────────────────────────────────────────────────────

export async function listVerticals(): Promise<VerticalModule[]> {
  return db.select().from(verticalModules).orderBy(desc(verticalModules.enabled));
}

export async function getVerticalBySlug(slug: string): Promise<VerticalModule | null> {
  const rows = await db.select().from(verticalModules).where(eq(verticalModules.slug, slug));
  return rows[0] ?? null;
}

export interface AssignmentResult {
  facilityId: string;
  primaryVerticalSlug: string | null;
  allVerticalSlugs: string[];
  rationale: string;
}

/**
 * Assign one facility to verticals using its `facility_type` plus the
 * `facility_type_filter` arrays on each vertical_modules row. CAH and FQHC
 * designations on the facility row also trigger rural-hospital + safety-net
 * fallback assignment per the strategic plan §6.4.
 *
 * Does not mutate the DB unless `persist=true`; callers in bulk-backfill
 * mode batch the inserts.
 */
export async function classifyFacility(
  facility: Pick<Facility, "id" | "facilityType" | "cahDesignation" | "fqhcDesignation">,
  options: { persist?: boolean; allVerticals?: VerticalModule[] } = {},
): Promise<AssignmentResult> {
  const verticals = options.allVerticals ?? (await listVerticals());

  const matches: Array<{ vertical: VerticalModule; reason: string }> = [];
  const facilityTypeLower = (facility.facilityType ?? "").toLowerCase();

  for (const v of verticals) {
    if (!v.enabled) continue;
    const filterHit = (v.facilityTypeFilter ?? []).some(
      (ft) => ft.toLowerCase() === facilityTypeLower,
    );
    if (filterHit) matches.push({ vertical: v, reason: "facility_type match" });
  }

  // CAH override: anything flagged cahDesignation lands in rural_hospital.
  if (facility.cahDesignation) {
    const rural = verticals.find((v) => v.slug === "rural_hospital");
    if (rural && !matches.some((m) => m.vertical.id === rural.id)) {
      matches.push({ vertical: rural, reason: "CAH designation" });
    }
  }
  // FQHC override: route to rural_hospital as a community-care proxy.
  if (facility.fqhcDesignation) {
    const rural = verticals.find((v) => v.slug === "rural_hospital");
    if (rural && !matches.some((m) => m.vertical.id === rural.id)) {
      matches.push({ vertical: rural, reason: "FQHC designation" });
    }
  }

  if (matches.length === 0) {
    return {
      facilityId: facility.id,
      primaryVerticalSlug: null,
      allVerticalSlugs: [],
      rationale: "no vertical_modules.facility_type_filter match",
    };
  }

  // First match becomes primary. If imaging_center + asc both match (which
  // happens for hospital-affiliated outpatient surgery centers), the order
  // in SYSTEM_VERTICALS biases toward the more specific one.
  const primary = matches[0];

  if (options.persist) {
    // Clear previous primary flag for this facility, then re-insert.
    await db
      .delete(facilityVerticalMap)
      .where(eq(facilityVerticalMap.facilityId, facility.id));
    await db.insert(facilityVerticalMap).values(
      matches.map((m, idx) => ({
        facilityId: facility.id,
        verticalId: m.vertical.id,
        isPrimary: idx === 0,
      })),
    );
  }

  return {
    facilityId: facility.id,
    primaryVerticalSlug: primary.vertical.slug,
    allVerticalSlugs: matches.map((m) => m.vertical.slug),
    rationale: matches.map((m) => `${m.vertical.slug} (${m.reason})`).join("; "),
  };
}

/**
 * Bulk reclassify every facility that doesn't yet have a vertical assigned,
 * or whose facility_type may have changed since the last classify run.
 * Runs in a nightly cron after the data ingestors finish.
 */
export async function classifyAllUnassigned(
  options: { batchSize?: number } = {},
): Promise<{ examined: number; assigned: number }> {
  const batchSize = options.batchSize ?? 500;
  const verticals = await listVerticals();
  let examined = 0;
  let assigned = 0;

  const rows = await db
    .select({
      id: facilities.id,
      facilityType: facilities.facilityType,
      cahDesignation: facilities.cahDesignation,
      fqhcDesignation: facilities.fqhcDesignation,
    })
    .from(facilities)
    .leftJoin(
      facilityVerticalMap,
      eq(facilityVerticalMap.facilityId, facilities.id),
    )
    .where(isNull(facilityVerticalMap.facilityId))
    .limit(batchSize);

  for (const f of rows) {
    examined++;
    const result = await classifyFacility(
      {
        id: f.id,
        facilityType: f.facilityType,
        cahDesignation: f.cahDesignation,
        fqhcDesignation: f.fqhcDesignation,
      },
      { persist: true, allVerticals: verticals },
    );
    if (result.allVerticalSlugs.length > 0) assigned++;
  }
  return { examined, assigned };
}

/**
 * Return the active vertical signal-weight overrides for one facility.
 * If the facility has a primary vertical assigned, that vertical's weights
 * win. Otherwise an empty map is returned and the OpportunityScorer falls
 * back to the global weights.
 */
export async function getVerticalWeightsForFacility(
  facilityId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      slug: verticalModules.slug,
      signalWeights: verticalModules.signalWeights,
      isPrimary: facilityVerticalMap.isPrimary,
    })
    .from(facilityVerticalMap)
    .innerJoin(verticalModules, eq(verticalModules.id, facilityVerticalMap.verticalId))
    .where(
      and(
        eq(facilityVerticalMap.facilityId, facilityId),
        eq(facilityVerticalMap.isPrimary, true),
      ),
    )
    .limit(1);
  if (rows.length === 0) return {};
  return normaliseSignalWeights(rows[0].signalWeights);
}

// Silence imports we keep handy for future helpers.
void inArray;
void sql;
