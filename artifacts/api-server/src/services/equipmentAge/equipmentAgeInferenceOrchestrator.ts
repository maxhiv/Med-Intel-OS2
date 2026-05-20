/**
 * Equipment-age inference orchestrator (v2.0 Phase D).
 *
 * Consolidates `equipment_age_evidence` rows into a best-estimate install
 * year per (facility, modality, manufacturer) via the
 * `v_equipment_age_inferred` SQL view, then writes the consensus back to
 * `equipment_records.install_year` when `age_confidence >= 0.6` AND at
 * least two distinct source types agree.
 *
 * Sources of evidence (per the v2.0 strategic plan §4 migration 009):
 *   - state radiation registries (TX, FL, CA, IL, NY) — highest weight
 *   - HCRIS A-7 age distribution (asset-class level)
 *   - manufacturer EOL bulletins (joined via Phase C matcher)
 *   - FDA 510(k) clearance date (model release year)
 *   - 990 Schedule D acquisition year
 *   - county permit application date
 *   - rep field reports
 *
 * Idempotent — re-runs only update equipment_records when the
 * v_equipment_age_inferred row changes by more than ±1 year (avoids churn).
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  equipmentRecords,
  equipmentAgeEvidence,
  type InsertEquipmentAgeEvidence,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { ClaimRegistry } from "../confidence/claimRegistry";

const MIN_CONFIDENCE_TO_OVERWRITE = 0.6;
const MIN_DISTINCT_SOURCES = 2;

interface InferredRow {
  facilityId: string;
  modality: string;
  manufacturer: string;
  estimatedInstallYear: number;
  ageConfidence: number;
  evidenceCount: number;
  distinctSourceCount: number;
  evidenceTypes: string[];
}

export interface InferenceResult {
  facilitiesScanned: number;
  consensusRowsRead: number;
  equipmentUpdated: number;
  claimsRecorded: number;
  skippedLowConfidence: number;
  skippedSingleSource: number;
  errors: number;
}

/** Read the consensus view. */
async function readConsensus(): Promise<InferredRow[]> {
  const rows = await db.execute<{
    facility_id: string;
    modality: string;
    manufacturer: string;
    estimated_install_year: number | null;
    age_confidence: string | number;
    evidence_count: number;
    distinct_source_count: number;
    evidence_types: string[];
  }>(sql`
    SELECT facility_id, modality, manufacturer,
           estimated_install_year, age_confidence,
           evidence_count, distinct_source_count, evidence_types
      FROM v_equipment_age_inferred
     WHERE estimated_install_year IS NOT NULL
  `);

  return rows.rows
    .filter((r) => r.estimated_install_year != null)
    .map((r) => ({
      facilityId: r.facility_id,
      modality: r.modality,
      manufacturer: r.manufacturer,
      estimatedInstallYear: Number(r.estimated_install_year),
      ageConfidence: Number(r.age_confidence),
      evidenceCount: Number(r.evidence_count),
      distinctSourceCount: Number(r.distinct_source_count),
      evidenceTypes: r.evidence_types ?? [],
    }));
}

/**
 * Apply the consensus rows to equipment_records. Returns the per-rule
 * counts so the cron can log a summary.
 */
export async function runInference(): Promise<InferenceResult> {
  const start = Date.now();
  const registry = new ClaimRegistry();
  const consensus = await readConsensus();

  const facilitiesSeen = new Set<string>();
  let consensusRowsRead = consensus.length;
  let equipmentUpdated = 0;
  let claimsRecorded = 0;
  let skippedLowConfidence = 0;
  let skippedSingleSource = 0;
  let errors = 0;

  for (const row of consensus) {
    facilitiesSeen.add(row.facilityId);

    if (row.ageConfidence < MIN_CONFIDENCE_TO_OVERWRITE) {
      skippedLowConfidence++;
      continue;
    }
    if (row.distinctSourceCount < MIN_DISTINCT_SOURCES) {
      skippedSingleSource++;
      continue;
    }

    try {
      // Find candidate equipment_records: same facility + modality, with a
      // matching manufacturer (or null manufacturer ↔ 'unknown' bucket).
      const candidates = await db
        .select({
          id: equipmentRecords.id,
          installYear: equipmentRecords.installYear,
          manufacturer: equipmentRecords.manufacturer,
        })
        .from(equipmentRecords)
        .where(
          and(
            eq(equipmentRecords.facilityId, row.facilityId),
            eq(equipmentRecords.modality, row.modality),
          ),
        );

      const matches = candidates.filter((c) => {
        const cm = (c.manufacturer ?? "unknown").toLowerCase();
        return cm === row.manufacturer.toLowerCase();
      });
      if (matches.length === 0) continue;

      for (const m of matches) {
        // Only overwrite when the new year differs from what's already
        // recorded by more than 1 year — avoid pointless churn.
        if (m.installYear != null && Math.abs(m.installYear - row.estimatedInstallYear) <= 1) {
          continue;
        }

        await db
          .update(equipmentRecords)
          .set({
            installYear: row.estimatedInstallYear,
            confidenceScore: row.ageConfidence.toFixed(2),
            sourceCount: row.distinctSourceCount,
            lastVerifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(equipmentRecords.id, m.id));
        equipmentUpdated++;

        // Anchor the claim so the confidence layer sees the
        // multi-source agreement and emits a `verified` status for the
        // equipment install year going forward.
        await registry.record({
          entityTable: "equipment_records",
          entityId: m.id,
          claimField: "install_year",
          claimValue: String(row.estimatedInstallYear),
          sourceType: row.evidenceTypes.includes("state_radiation_registry")
            ? "state_radiation_registry"
            : row.evidenceTypes[0] ?? "manual_curator",
        });
        claimsRecorded++;
      }
    } catch (err) {
      errors++;
      logger.error(
        { err, facilityId: row.facilityId, modality: row.modality },
        "equipment-age consensus apply failed",
      );
    }
  }

  logger.info(
    {
      facilitiesScanned: facilitiesSeen.size,
      consensusRowsRead,
      equipmentUpdated,
      claimsRecorded,
      skippedLowConfidence,
      skippedSingleSource,
      errors,
      ms: Date.now() - start,
    },
    "equipment-age inference complete",
  );

  return {
    facilitiesScanned: facilitiesSeen.size,
    consensusRowsRead,
    equipmentUpdated,
    claimsRecorded,
    skippedLowConfidence,
    skippedSingleSource,
    errors,
  };
}

/**
 * Helper used by state-registry adapters in `./stateRegistries/*` to append
 * evidence in bulk. Caller is responsible for facility_id resolution.
 */
export async function appendEvidence(rows: InsertEquipmentAgeEvidence[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db.insert(equipmentAgeEvidence).values(rows);
  return rows.length;
}

void isNotNull;
