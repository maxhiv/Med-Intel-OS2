/**
 * System Signal Propagator
 *
 * For each parent health-system facility, finds the Tier 1 signals on its
 * children and upserts them as `system_signal_propagated` signals on:
 *   • every sibling child (confidence 0.80)
 *   • the parent itself (confidence 0.90)
 *
 * Uses ON CONFLICT DO NOTHING so repeated runs are idempotent.
 * After propagation, triggers a full score recompute so dashboards
 * stay fresh.
 */

import { eq, and, sql, isNotNull, ne } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { recomputeAllScores } from "./signalScorer";
import { logger } from "../lib/logger";

const TIER1_SIGNAL_TYPES = [
  "con_filed",
  "con_approved",
  "bond_issued",
  "rfp_posted",
  "hcris_depreciation_spike",
] as const;

export interface PropagationResult {
  parentSystemsProcessed: number;
  siblingsSignaled: number;
  parentSignalUpserts: number;
  scoresRecomputed: number;
  errors: number;
}

export async function propagateSystemSignals(): Promise<PropagationResult> {
  const result: PropagationResult = {
    parentSystemsProcessed: 0,
    siblingsSignaled: 0,
    parentSignalUpserts: 0,
    scoresRecomputed: 0,
    errors: 0,
  };

  const parentSystems = await db
    .select({ id: facilities.id, name: facilities.name })
    .from(facilities)
    .where(eq(facilities.facilityType, "health_system"));

  for (const parent of parentSystems) {
    try {
      const children = await db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.parentSystemId, parent.id));

      if (children.length === 0) continue;

      const childIds = children.map((c) => c.id);

      const tier1Signals = await db
        .select({
          signalType: purchaseSignals.signalType,
          source: purchaseSignals.source,
          signalValue: purchaseSignals.signalValue,
          detectedAt: purchaseSignals.detectedAt,
        })
        .from(purchaseSignals)
        .where(
          and(
            sql`${purchaseSignals.facilityId} = ANY(ARRAY[${sql.join(childIds.map((id) => sql`${id}::uuid`), sql`, `)}])`,
            sql`${purchaseSignals.signalType} = ANY(ARRAY[${sql.join(TIER1_SIGNAL_TYPES.map((t) => sql`${t}::signal_type`), sql`, `)}]::signal_type[])`,
            eq(purchaseSignals.isActive, true),
          ),
        );

      if (tier1Signals.length === 0) continue;

      for (const sig of tier1Signals) {
        const propagatedValue = `propagated:${sig.signalValue ?? sig.signalType}:from_system:${parent.id}`;

        for (const child of children) {
          await db
            .insert(purchaseSignals)
            .values({
              facilityId: child.id,
              signalType: "system_signal_propagated",
              signalValue: propagatedValue,
              confidence: 80,
              source: "system_propagation",
              isActive: true,
              detectedAt: sig.detectedAt ?? new Date(),
            })
            .onConflictDoNothing();
          result.siblingsSignaled++;
        }

        await db
          .insert(purchaseSignals)
          .values({
            facilityId: parent.id,
            signalType: "system_signal_propagated",
            signalValue: propagatedValue,
            confidence: 90,
            source: "system_propagation",
            isActive: true,
            detectedAt: sig.detectedAt ?? new Date(),
          })
          .onConflictDoNothing();
        result.parentSignalUpserts++;
      }

      result.parentSystemsProcessed++;
      logger.info(
        { parentId: parent.id, name: parent.name, tier1SignalCount: tier1Signals.length },
        "system signals propagated",
      );
    } catch (err) {
      result.errors++;
      logger.error({ err, parentId: parent.id }, "system propagation failed for parent");
    }
  }

  const recomputed = await recomputeAllScores();
  result.scoresRecomputed = recomputed.updated;

  return result;
}
