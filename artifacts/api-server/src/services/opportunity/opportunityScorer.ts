/**
 * OpportunityScorer (v2.0 Phase E).
 *
 * Implements the strategic plan §7 formula:
 *
 *   opportunity_score =
 *     facility_buying_readiness * 0.40 +
 *     trigger_recency_score     * 0.20 +
 *     contact_confidence_score  * 0.15 +
 *     vertical_fit_score        * 0.15 +
 *     territory_proximity_score * 0.10
 *
 * Components:
 *   - facility_buying_readiness: sum of active purchase_signal weights for
 *     the (facility, modality) tuple. Capped at 1.0.
 *   - trigger_recency_score:     newest active signal scaled by age (decays
 *     to 0 over 365 days).
 *   - contact_confidence_score:  avg of confidence on the champion +
 *     economic buyer + gatekeeper contacts (when known). Defaults to 0.3
 *     when no contacts in the triangle are mapped.
 *   - vertical_fit_score:        1.0 when facility belongs to a vertical
 *     whose primary_modalities include the opportunity modality; 0.5
 *     otherwise.
 *   - territory_proximity_score: 1.0 if facility.state is in the rep's
 *     covered states; 0.5 otherwise. Falls back to 0.5 when no territory
 *     binding exists.
 *
 * Returns 0..1, with a full breakdown so the UI can show "why this score".
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  purchaseSignals,
  facilities,
  facilityContacts,
  type Facility,
  type Opportunity,
} from "@workspace/db";

// Per-signal weight reused from signalScorer.WEIGHTS — duplicated here to
// avoid a circular import. Keep in sync as new signal types ship.
const SIGNAL_WEIGHTS: Record<string, number> = {
  con_filed: 35, con_approved: 40, bond_issued: 35, rfp_posted: 40,
  hcris_depreciation_spike: 25, equipment_age_7yr: 20, high_utilization: 15,
  grant_awarded: 25, clinical_trial: 15, adverse_event_spike: 10, sec_capex_flag: 18,
  depreciation_flag: 12, eol_equipment: 35,
  chow_recent: 35, pe_takeover: 30, reit_takeover: 28, aip_infra_spend: 25,
  chain_acquisition: 12, psi11_outlier: 15, cmmi_state_launch: 5,
  accreditation_renewal: 25,
};

// Per-modality typical capital range (USD). Used to compute the opportunity
// dollar range, scaled by facility bed count when known.
const MODALITY_DOLLAR_RANGES: Record<string, [number, number]> = {
  MRI: [600_000, 2_500_000],
  CT: [200_000, 1_200_000],
  PET: [800_000, 2_500_000],
  mammo: [100_000, 400_000],
  fluoro: [80_000, 400_000],
  "C-arm": [80_000, 250_000],
  ultrasound: [40_000, 250_000],
  DXA: [40_000, 80_000],
  surgical_robot: [800_000, 2_500_000],
  linac: [1_500_000, 6_000_000],
  endoscopy: [50_000, 400_000],
  anesthesia: [40_000, 150_000],
  unknown: [50_000, 500_000],
};

export interface OpportunityScoreBreakdown {
  readinessScore: number;          // 0..1
  triggerRecencyScore: number;     // 0..1
  contactConfidenceScore: number;  // 0..1
  verticalFitScore: number;        // 0..1
  territoryProximityScore: number; // 0..1
  composite: number;               // 0..1 (weighted sum)
  components: Record<string, number>;
}

export interface ScoringInput {
  facility: Pick<Facility, "id" | "state" | "beds" | "facilityType">;
  modality: string;
  /** Active signals from purchase_signals for this facility. */
  signals: Array<{
    signalType: string;
    detectedAt: Date | null;
    confidence: number | null;
  }>;
  /** Vertical with its primary modalities (already resolved). */
  primaryVerticalSlug: string | null;
  verticalPrimaryModalities: string[];
  /** True if the rep covers the facility's state. */
  inTerritory: boolean;
  /** Contact triangle confidence values (each 0..1, 0 if unknown). */
  championConfidence: number;
  economicBuyerConfidence: number;
  gatekeeperConfidence: number;
}

const NOW_MS = () => Date.now();

function triggerRecency(signals: ScoringInput["signals"]): number {
  if (signals.length === 0) return 0;
  let best = 0;
  for (const s of signals) {
    if (!s.detectedAt) continue;
    const ageDays = (NOW_MS() - s.detectedAt.getTime()) / (1000 * 60 * 60 * 24);
    const score = Math.max(0, 1 - ageDays / 365);
    if (score > best) best = score;
  }
  return best;
}

function buyingReadiness(signals: ScoringInput["signals"]): number {
  if (signals.length === 0) return 0;
  // Sum of (signal_weight × confidence/100), capped at 100, normalised to 0..1.
  let raw = 0;
  for (const s of signals) {
    const weight = SIGNAL_WEIGHTS[s.signalType] ?? 5;
    const conf = (s.confidence ?? 50) / 100;
    raw += weight * conf;
  }
  return Math.min(1, raw / 100);
}

function verticalFit(input: ScoringInput): number {
  if (!input.primaryVerticalSlug) return 0.5;
  return input.verticalPrimaryModalities.includes(input.modality) ? 1.0 : 0.5;
}

function contactConfidence(input: ScoringInput): number {
  const present = [
    input.championConfidence,
    input.economicBuyerConfidence,
    input.gatekeeperConfidence,
  ].filter((c) => c > 0);
  if (present.length === 0) return 0.3; // unknown contact triangle floor
  const avg = present.reduce((a, b) => a + b, 0) / present.length;
  // Reward completeness — full triangle gets a 1.15× bump.
  const completeness = present.length / 3;
  return Math.min(1, avg * (0.85 + 0.15 * completeness * 2));
}

export function score(input: ScoringInput): OpportunityScoreBreakdown {
  const readinessScore = buyingReadiness(input.signals);
  const triggerRecencyScore = triggerRecency(input.signals);
  const contactConfidenceScore = contactConfidence(input);
  const verticalFitScore = verticalFit(input);
  const territoryProximityScore = input.inTerritory ? 1.0 : 0.5;

  const composite =
    readinessScore * 0.4 +
    triggerRecencyScore * 0.2 +
    contactConfidenceScore * 0.15 +
    verticalFitScore * 0.15 +
    territoryProximityScore * 0.1;

  return {
    readinessScore,
    triggerRecencyScore,
    contactConfidenceScore,
    verticalFitScore,
    territoryProximityScore,
    composite: Math.min(1, Math.max(0, composite)),
    components: {
      readiness_pts: readinessScore * 40,
      recency_pts: triggerRecencyScore * 20,
      contact_pts: contactConfidenceScore * 15,
      vertical_pts: verticalFitScore * 15,
      territory_pts: territoryProximityScore * 10,
    },
  };
}

export function estimateDollarRange(
  modality: string,
  beds: number | null | undefined,
): { low: number; high: number } {
  const range = MODALITY_DOLLAR_RANGES[modality] ?? MODALITY_DOLLAR_RANGES.unknown;
  // Scale by bed count — anchor at 100 beds = baseline; 25-bed CAH = 0.5x,
  // 500-bed referral center = 1.5x. Capped at [0.4, 1.6].
  const bedFactor = beds && beds > 0 ? Math.max(0.4, Math.min(1.6, beds / 100)) : 1;
  return {
    low: Math.round(range[0] * bedFactor),
    high: Math.round(range[1] * bedFactor),
  };
}

// ─── DB-touching helpers ────────────────────────────────────────────────────

/** Load all active purchase_signals for a facility (any modality). */
export async function loadActiveSignals(facilityId: string): Promise<ScoringInput["signals"]> {
  const rows = await db
    .select({
      signalType: purchaseSignals.signalType,
      detectedAt: purchaseSignals.detectedAt,
      confidence: purchaseSignals.confidence,
    })
    .from(purchaseSignals)
    .where(and(eq(purchaseSignals.facilityId, facilityId), eq(purchaseSignals.isActive, true)));
  return rows;
}

/** Best confidence proxy for a contact (combines verification_status + confidence_score). */
export function contactConfidenceFromRow(row: {
  confidenceScore: number | null;
  verificationStatus: string | null;
}): number {
  const base = (row.confidenceScore ?? 0) / 100;
  if (row.verificationStatus === "verified") return Math.max(base, 0.85);
  if (row.verificationStatus === "stale" || row.verificationStatus === "bounced") return Math.min(base, 0.3);
  return base;
}

/**
 * Pull the highest-confidence contact for a (facility, buyer_role) tuple.
 * Returns null when no such contact exists.
 */
export async function findContactForRole(
  facilityId: string,
  buyerRole: "clinical_champion" | "economic_buyer" | "procurement_gatekeeper",
): Promise<{ id: string; confidence: number } | null> {
  const rows = await db
    .select({
      id: facilityContacts.id,
      confidenceScore: facilityContacts.confidenceScore,
      verificationStatus: facilityContacts.verificationStatus,
    })
    .from(facilityContacts)
    .where(
      and(
        eq(facilityContacts.facilityId, facilityId),
        eq(facilityContacts.buyerRole, buyerRole),
      ),
    )
    .orderBy(sql`COALESCE(${facilityContacts.confidenceScore}, 0) DESC`)
    .limit(1);
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    confidence: contactConfidenceFromRow(rows[0]),
  };
}

void isNotNull;
void ((_: Opportunity) => undefined);
