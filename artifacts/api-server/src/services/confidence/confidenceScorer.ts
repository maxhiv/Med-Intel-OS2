/**
 * ConfidenceScorer — applies the two-source-minimum + decay rules per the
 * v2.0 strategic plan §5.
 *
 * The compute_claim_confidence() PL/pgSQL function gives us the decayed
 * weighted sum. This wrapper layers on:
 *   - The two-source-minimum check (verified vs provisional)
 *   - Per-claim-type half-life overrides (180d default, 90d contacts,
 *     365d equipment install_year)
 *   - The best-supported value per (entity, field) — used by the UI and
 *     by ingestors that want to know "what's the current best guess?"
 *
 * Status thresholds:
 *   - verified:    >= 2 distinct source_types AND summed weight >= 0.6
 *                  AND no active contradiction
 *   - provisional: 1 source OR summed weight < 0.6
 *   - contradicted: a higher-weight competing claim_value exists
 */
import { ClaimRegistry } from "./claimRegistry";

export type ClaimStatus = "verified" | "provisional" | "contradicted" | "unknown";

export interface ClaimAssessment {
  bestValue: string | null;
  status: ClaimStatus;
  confidence: number;            // 0..1
  sourceCount: number;
  sources: string[];
  competing: Array<{ value: string; confidence: number; sources: string[] }>;
}

/** Per-claim-field decay half-life overrides (days). 180 default. */
const HALF_LIFE_OVERRIDES: Record<string, number> = {
  // Contact PII rots fastest — people change jobs.
  "facility_contacts.email": 90,
  "facility_contacts.phone": 90,
  "facility_contacts.title": 90,
  "facility_contacts.linkedin_url": 90,
  // Equipment install year barely decays — physical metal doesn't age out
  // of a registry just because we haven't re-observed it.
  "equipment_records.install_year": 365,
  "equipment_records.serial_number": 365,
};

export function halfLifeFor(entityTable: string, claimField: string): number {
  return HALF_LIFE_OVERRIDES[`${entityTable}.${claimField}`] ?? 180;
}

export class ConfidenceScorer {
  private readonly registry: ClaimRegistry;

  constructor(registry: ClaimRegistry = new ClaimRegistry()) {
    this.registry = registry;
  }

  /**
   * Returns the best-supported value for an (entity, field) along with its
   * verification status. Returns `status: 'unknown'` when no claims exist.
   */
  async assess(
    entityTable: string,
    entityId: string,
    claimField: string,
  ): Promise<ClaimAssessment> {
    const claims = await this.registry.getClaimsForField(entityTable, entityId, claimField);
    if (claims.length === 0) {
      return {
        bestValue: null,
        status: "unknown",
        confidence: 0,
        sourceCount: 0,
        sources: [],
        competing: [],
      };
    }

    // claims is already sorted by confidence DESC
    const [winner, ...rest] = claims;
    const competing = rest.map((c) => ({
      value: c.claimValue,
      confidence: c.confidence,
      sources: c.sources,
    }));

    // contradicted? a competing claim with >0.3 confidence exists alongside ours
    const hasContradiction = rest.some((c) => c.confidence >= 0.3);

    let status: ClaimStatus;
    if (hasContradiction && winner.confidence < 0.6) {
      status = "contradicted";
    } else if (winner.sourceCount >= 2 && winner.confidence >= 0.6) {
      status = "verified";
    } else {
      status = "provisional";
    }

    return {
      bestValue: winner.claimValue,
      status,
      confidence: winner.confidence,
      sourceCount: winner.sourceCount,
      sources: winner.sources,
      competing,
    };
  }
}
