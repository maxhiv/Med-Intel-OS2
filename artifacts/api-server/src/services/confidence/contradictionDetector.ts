/**
 * ContradictionDetector — nightly sweep that finds (entity, field) tuples
 * where two or more distinct claim values both carry non-trivial weight.
 * For each such tuple, the lower-weight values are flagged
 * `contradicted_by` the higher-weight winner so the confidence scorer no
 * longer counts them.
 *
 * "Non-trivial weight" threshold: 0.3 of summed-decayed weight per value.
 * "Winner" threshold: the highest-weight value must outweigh the runner-up
 * by at least 1.5x; if not, both stay live (genuinely ambiguous — defer
 * to human curator).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger";

const MIN_VALUE_WEIGHT = 0.3;
const WINNER_RATIO = 1.5;

export interface DetectorResult {
  tuplesScanned: number;
  contradictionsFlagged: number;
  ambiguous: number;
  errors: number;
}

export async function detectContradictions(): Promise<DetectorResult> {
  const start = Date.now();
  let tuplesScanned = 0;
  let contradictionsFlagged = 0;
  let ambiguous = 0;
  let errors = 0;

  try {
    // Find (entity_table, entity_id, claim_field) tuples with > 1 distinct value.
    const candidates = await db.execute<{
      entity_table: string;
      entity_id: string;
      claim_field: string;
    }>(sql`
      SELECT entity_table, entity_id, claim_field
        FROM intelligence_claims
       WHERE contradicted_by IS NULL
       GROUP BY entity_table, entity_id, claim_field
      HAVING COUNT(DISTINCT claim_value) >= 2
    `);

    for (const c of candidates.rows) {
      tuplesScanned++;
      try {
        // Pull each distinct value's decayed weight.
        const valuesByWeight = await db.execute<{
          claim_value: string;
          summed_weight: string;
          claim_ids: number[];
        }>(sql`
          SELECT
            claim_value,
            SUM(
              source_weight *
              EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - observed_at)) / (180 * 86400))
            )::text AS summed_weight,
            ARRAY_AGG(id ORDER BY observed_at DESC) AS claim_ids
          FROM intelligence_claims
          WHERE entity_table = ${c.entity_table}::text
            AND entity_id = ${c.entity_id}::uuid
            AND claim_field = ${c.claim_field}::text
            AND contradicted_by IS NULL
          GROUP BY claim_value
          ORDER BY summed_weight::numeric DESC
        `);

        const ranked = valuesByWeight.rows.map((r) => ({
          claimValue: r.claim_value,
          weight: Number(r.summed_weight ?? 0),
          claimIds: r.claim_ids ?? [],
        }));
        if (ranked.length < 2) continue;

        const winner = ranked[0];
        const runnerUp = ranked[1];

        // Both below the threshold? noise, skip.
        if (winner.weight < MIN_VALUE_WEIGHT) continue;

        // Winner not clearly ahead? ambiguous, leave both live.
        if (runnerUp.weight >= MIN_VALUE_WEIGHT && winner.weight < runnerUp.weight * WINNER_RATIO) {
          ambiguous++;
          logger.warn(
            {
              entityTable: c.entity_table,
              entityId: c.entity_id,
              claimField: c.claim_field,
              candidates: ranked.slice(0, 3),
            },
            "ambiguous claim values — neither side has 1.5x weight; flagging for human review",
          );
          continue;
        }

        // Flag the losing values as contradicted by the winner's most-recent claim.
        const winnerAnchor = winner.claimIds[0];
        if (!winnerAnchor) continue;

        for (const loser of ranked.slice(1)) {
          if (loser.weight < MIN_VALUE_WEIGHT) continue;
          if (loser.claimIds.length === 0) continue;
          await db.execute(sql`
            UPDATE intelligence_claims
               SET contradicted_by = ${winnerAnchor}
             WHERE id = ANY(${loser.claimIds}::bigint[])
               AND contradicted_by IS NULL
          `);
          contradictionsFlagged += loser.claimIds.length;
        }
      } catch (err) {
        errors++;
        logger.error({ err, candidate: c }, "contradiction detector tuple failed");
      }
    }
  } catch (err) {
    errors++;
    logger.error({ err }, "contradiction detector candidate query failed");
  }

  logger.info(
    { tuplesScanned, contradictionsFlagged, ambiguous, errors, ms: Date.now() - start },
    "contradiction detector complete",
  );
  return { tuplesScanned, contradictionsFlagged, ambiguous, errors };
}
