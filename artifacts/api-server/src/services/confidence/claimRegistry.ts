/**
 * ClaimRegistry — the typed adapter every v2.0 ingestor calls to record an
 * intelligence_claim with the right source weight.
 *
 * Why this exists: per Rule 3 in the project conventions, no claim is
 * `verified` from a single source. Every observation lands here with a
 * citation; the confidence scorer collapses them into a 0..1 score using
 * the compute_claim_confidence() SQL function (180-day half-life decay).
 *
 * Usage:
 *   const registry = new ClaimRegistry();
 *   await registry.record({
 *     entityTable: 'equipment_records',
 *     entityId: equipment.id,                // UUID
 *     claimField: 'install_year',
 *     claimValue: String(2018),
 *     sourceType: 'state_radiation_registry',
 *     sourceUrl: 'https://www.tdlr.texas.gov/...',
 *     // sourceWeight optional — looked up from source_weights table
 *   });
 *   const c = await registry.getConfidence(
 *     'equipment_records', equipment.id, 'install_year', '2018',
 *   ); // → 0.95 (one ground-truth source, no decay)
 */
import { eq, sql } from "drizzle-orm";
import { db, intelligenceClaims, sourceWeights } from "@workspace/db";

const DEFAULT_FALLBACK_WEIGHT = 0.4;
const WEIGHT_CACHE = new Map<string, number>();
const WEIGHT_CACHE_LOADED_AT = { value: 0 };
const WEIGHT_CACHE_TTL_MS = 5 * 60_000; // 5-minute soft TTL; lazy refresh

export interface RecordClaimInput {
  entityTable: string;
  entityId: string; // UUID
  claimField: string;
  claimValue: string | number | boolean | Date;
  sourceType: string;
  sourceUrl?: string | null;
  sourceWeight?: number; // override the catalog default
  observedAt?: Date;
}

function normaliseValue(v: string | number | boolean | Date): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function refreshWeightCache(): Promise<void> {
  const rows = await db
    .select({ sourceType: sourceWeights.sourceType, defaultWeight: sourceWeights.defaultWeight })
    .from(sourceWeights);
  WEIGHT_CACHE.clear();
  for (const r of rows) WEIGHT_CACHE.set(r.sourceType, Number(r.defaultWeight));
  WEIGHT_CACHE_LOADED_AT.value = Date.now();
}

export class ClaimRegistry {
  /**
   * Looks up the catalog default weight for a source_type. Falls back to
   * DEFAULT_FALLBACK_WEIGHT (0.40) when a source_type isn't listed.
   */
  async getDefaultWeight(sourceType: string): Promise<number> {
    if (Date.now() - WEIGHT_CACHE_LOADED_AT.value > WEIGHT_CACHE_TTL_MS) {
      await refreshWeightCache();
    }
    return WEIGHT_CACHE.get(sourceType) ?? DEFAULT_FALLBACK_WEIGHT;
  }

  /**
   * Record a single observation. Idempotency note: the table allows
   * duplicate observations from the same source — that's intentional, the
   * scorer counts distinct source_types, not row count, when checking the
   * two-source-minimum threshold.
   */
  async record(input: RecordClaimInput): Promise<void> {
    const weight = input.sourceWeight ?? (await this.getDefaultWeight(input.sourceType));
    const claimValue = normaliseValue(input.claimValue);
    await db.insert(intelligenceClaims).values({
      entityTable: input.entityTable,
      entityId: input.entityId,
      claimField: input.claimField,
      claimValue,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      sourceWeight: weight.toFixed(2),
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    });
  }

  /**
   * Record many claims in one transaction. Used by bulk ingestors.
   */
  async recordBatch(inputs: RecordClaimInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const values = await Promise.all(
      inputs.map(async (input) => {
        const weight = input.sourceWeight ?? (await this.getDefaultWeight(input.sourceType));
        return {
          entityTable: input.entityTable,
          entityId: input.entityId,
          claimField: input.claimField,
          claimValue: normaliseValue(input.claimValue),
          sourceType: input.sourceType,
          sourceUrl: input.sourceUrl ?? null,
          sourceWeight: weight.toFixed(2),
          ...(input.observedAt ? { observedAt: input.observedAt } : {}),
        };
      }),
    );
    await db.insert(intelligenceClaims).values(values);
  }

  /**
   * Calls the compute_claim_confidence() SQL function. Returns a 0..1
   * score that already accounts for decay and contradiction.
   */
  async getConfidence(
    entityTable: string,
    entityId: string,
    claimField: string,
    claimValue: string | number | boolean | Date,
  ): Promise<number> {
    const value = normaliseValue(claimValue);
    const rows = await db.execute<{ c: string | number }>(sql`
      SELECT compute_claim_confidence(
        ${entityTable}::text,
        ${entityId}::uuid,
        ${claimField}::text,
        ${value}::text
      ) AS c
    `);
    const row = rows.rows[0];
    return row ? Number(row.c ?? 0) : 0;
  }

  /**
   * For a given (entity, field), return every distinct claim_value with
   * its computed confidence — handy for the UI's "this fact, from these
   * sources" panel and for the contradiction detector.
   */
  async getClaimsForField(
    entityTable: string,
    entityId: string,
    claimField: string,
  ): Promise<
    Array<{
      claimValue: string;
      sources: string[];
      sourceCount: number;
      summedWeight: number;
      confidence: number;
      lastObservedAt: Date | null;
    }>
  > {
    const rows = await db.execute<{
      claim_value: string;
      sources: string[];
      source_count: number;
      summed_weight: string;
      confidence: string;
      last_observed_at: Date | null;
    }>(sql`
      WITH grouped AS (
        SELECT
          claim_value,
          ARRAY_AGG(DISTINCT source_type) AS sources,
          COUNT(DISTINCT source_type)::int AS source_count,
          SUM(source_weight)::text AS summed_weight,
          MAX(observed_at) AS last_observed_at
        FROM intelligence_claims
        WHERE entity_table = ${entityTable}::text
          AND entity_id = ${entityId}::uuid
          AND claim_field = ${claimField}::text
          AND contradicted_by IS NULL
        GROUP BY claim_value
      )
      SELECT
        g.*,
        compute_claim_confidence(
          ${entityTable}::text,
          ${entityId}::uuid,
          ${claimField}::text,
          g.claim_value
        )::text AS confidence
      FROM grouped g
      ORDER BY confidence::numeric DESC
    `);
    return rows.rows.map((r) => ({
      claimValue: r.claim_value,
      sources: r.sources,
      sourceCount: r.source_count,
      summedWeight: Number(r.summed_weight ?? 0),
      confidence: Number(r.confidence ?? 0),
      lastObservedAt: r.last_observed_at,
    }));
  }

  /**
   * Reset the in-memory weight cache. Tests call this after seeding new
   * weights; production code does not need to invoke it.
   */
  static resetCache(): void {
    WEIGHT_CACHE.clear();
    WEIGHT_CACHE_LOADED_AT.value = 0;
  }
}

void eq; // re-exported for future per-source-type weight-lookup helpers
