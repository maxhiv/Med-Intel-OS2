/**
 * Generic state-radiation-registry adapter — pulls newly-staged rows from
 * `stage_state_registry_radiation`, resolves facility_npi → facilities.id,
 * and writes `equipment_age_evidence` rows plus the matching
 * `equipment_records` entries when the model is brand-new to a facility.
 *
 * Why no live HTTP scraping in v2.0:
 *   Each state portal has its own captcha / form / rate-limit story, and
 *   Definitive Healthcare burned three engineers automating these before
 *   landing on "operator drops a CSV into staging, the platform absorbs
 *   it deterministically." We follow the same playbook here — drop a CSV
 *   from your state's portal into the staging table, call this adapter.
 *
 * Per-state weight overrides (`getStateRegistryWeight`) reflect the
 * relative authoritativeness of each portal:
 *   - TX (DSHS RAD database)   → 0.95 (most complete coverage)
 *   - FL (DOH BOR)              → 0.92
 *   - CA (DPH RHB)              → 0.90
 *   - IL (IEMA)                 → 0.88
 *   - NY (DOH BERP)             → 0.88
 *   - other states              → 0.85
 *
 * Idempotency: rows in stage_state_registry_radiation get a
 * `processed_at` timestamp on first successful absorption; subsequent
 * runs skip already-processed rows.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  facilities,
  equipmentRecords,
  stageStateRegistryRadiation,
  equipmentAgeEvidence,
} from "@workspace/db";
import { logger } from "../../../lib/logger";
import { appendEvidence } from "../equipmentAgeInferenceOrchestrator";

export interface AdapterResult {
  state?: string;
  stagedRowsScanned: number;
  evidenceWritten: number;
  equipmentRecordsCreated: number;
  unmatchedNpi: number;
  errors: number;
}

const STATE_REGISTRY_WEIGHTS: Record<string, number> = {
  TX: 0.95,
  FL: 0.92,
  CA: 0.9,
  IL: 0.88,
  NY: 0.88,
};

function getStateRegistryWeight(state: string): number {
  return STATE_REGISTRY_WEIGHTS[state.toUpperCase()] ?? 0.85;
}

/**
 * Read all unprocessed rows for one state, resolve NPIs to facility_ids,
 * write evidence + (optionally) seed an equipment_records skeleton row.
 * `state=null` processes every state in one pass.
 */
export async function ingestStateRadiationRegistry(
  state: string | null = null,
): Promise<AdapterResult> {
  const start = Date.now();
  let evidenceWritten = 0;
  let equipmentRecordsCreated = 0;
  let unmatchedNpi = 0;
  let errors = 0;

  const conds = [isNull(stageStateRegistryRadiation.processedAt)];
  if (state) conds.push(eq(stageStateRegistryRadiation.state, state.toUpperCase()));

  const staged = await db
    .select()
    .from(stageStateRegistryRadiation)
    .where(and(...conds));

  if (staged.length === 0) {
    return {
      state: state ?? undefined,
      stagedRowsScanned: 0,
      evidenceWritten: 0,
      equipmentRecordsCreated: 0,
      unmatchedNpi: 0,
      errors: 0,
    };
  }

  // Resolve facility_npi → facilities.id in one batched query.
  const npis = Array.from(
    new Set(
      staged.map((r) => r.facilityNpi).filter((v): v is string => Boolean(v && /^\d{10}$/.test(v))),
    ),
  );
  const facilityRows =
    npis.length > 0
      ? await db
          .select({ id: facilities.id, npi: facilities.npi })
          .from(facilities)
          .where(sql`${facilities.npi} = ANY(${npis}::varchar[])`)
      : [];
  const facilityIdByNpi = new Map(facilityRows.map((r) => [r.npi, r.id]));

  for (const row of staged) {
    try {
      const fid = row.facilityNpi ? facilityIdByNpi.get(row.facilityNpi) : undefined;
      if (!fid) {
        unmatchedNpi++;
        // Don't mark as processed; rep can backfill the NPI and re-run.
        continue;
      }

      const weight = getStateRegistryWeight(row.state);
      const installYear = row.installYear ?? null;

      // 1) Write evidence row — anchors the v_equipment_age_inferred view.
      await appendEvidence([
        {
          facilityId: fid,
          modality: inferModalityFromModel(row.model),
          manufacturer: row.manufacturer,
          model: row.model,
          evidenceType: "state_registry",
          evidenceValue: {
            state: row.state,
            registrationNumber: row.registrationNumber,
            registrationDate: row.registrationDate,
            lastInspectionDate: row.lastInspectionDate,
            registrationExpiry: row.registrationExpiry,
            serialNumber: row.serialNumber,
            sourceFile: row.sourceFile,
          },
          inferredInstallYear: installYear,
          evidenceWeight: weight.toFixed(2),
          sourceUrl: row.sourceFile,
        },
      ]);
      evidenceWritten++;

      // 2) Seed an equipment_records row if none exists for this exact
      //    (facility, modality, model). Subsequent runs will just refresh
      //    the inferred install year via the orchestrator.
      const modality = inferModalityFromModel(row.model);
      const existing = await db
        .select({ id: equipmentRecords.id })
        .from(equipmentRecords)
        .where(
          and(
            eq(equipmentRecords.facilityId, fid),
            eq(equipmentRecords.modality, modality),
            row.model ? eq(equipmentRecords.model, row.model) : sql`TRUE`,
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        await db.insert(equipmentRecords).values({
          facilityId: fid,
          modality,
          manufacturer: row.manufacturer ?? null,
          model: row.model ?? null,
          serialNumber: row.serialNumber ?? null,
          installYear: installYear ?? null,
          stateRegistryId: row.registrationNumber ?? null,
          confidenceScore: weight.toFixed(2),
          sourceCount: 1,
          urgencyTier: "unknown",
        });
        equipmentRecordsCreated++;
      } else {
        // Equipment record exists — backfill the state_registry_id and
        // install_year if missing so the next inference pass can pick them up.
        await db
          .update(equipmentRecords)
          .set({
            stateRegistryId: row.registrationNumber ?? undefined,
            installYear: existing[0].id && row.installYear ? row.installYear : undefined,
            updatedAt: new Date(),
          })
          .where(eq(equipmentRecords.id, existing[0].id));
      }

      // 3) Stamp the staging row as processed.
      await db
        .update(stageStateRegistryRadiation)
        .set({ processedAt: new Date() })
        .where(eq(stageStateRegistryRadiation.id, row.id));
    } catch (err) {
      errors++;
      logger.error({ err, stageRowId: row.id }, "state registry row absorption failed");
    }
  }

  logger.info(
    {
      state,
      stagedRowsScanned: staged.length,
      evidenceWritten,
      equipmentRecordsCreated,
      unmatchedNpi,
      errors,
      ms: Date.now() - start,
    },
    "state radiation registry ingest complete",
  );

  return {
    state: state ?? undefined,
    stagedRowsScanned: staged.length,
    evidenceWritten,
    equipmentRecordsCreated,
    unmatchedNpi,
    errors,
  };
}

/**
 * Best-effort modality inference from a model string. Falls back to
 * 'unknown' when the model isn't recognised — the operator can refine via
 * the admin UI (Phase E follow-up).
 */
function inferModalityFromModel(model: string | null | undefined): string {
  if (!model) return "unknown";
  const m = model.toLowerCase();
  if (m.includes("ct") || m.includes("aquilion") || m.includes("somatom") || m.includes("brilliance") || m.includes("revolution") || m.includes("lightspeed") || m.includes("optima")) {
    return "CT";
  }
  if (m.includes("mri") || m.includes("magnetom") || m.includes("signa") || m.includes("ingenia") || m.includes("achieva")) {
    return "MRI";
  }
  if (m.includes("mammo") || m.includes("selenia") || m.includes("dimensions") || m.includes("3dimensions")) {
    return "mammo";
  }
  if (m.includes("c-arm") || m.includes("c arm") || m.includes("oec") || m.includes("ziehm")) {
    return "C-arm";
  }
  if (m.includes("fluoro")) return "fluoro";
  if (m.includes("ultrasound") || m.includes("logiq") || m.includes("acuson") || m.includes("epiq")) {
    return "ultrasound";
  }
  if (m.includes("pet")) return "PET";
  if (m.includes("dxa") || m.includes("horizon")) return "DXA";
  if (m.includes("linac") || m.includes("truebeam") || m.includes("halcyon") || m.includes("synergy") || m.includes("versa")) {
    return "linac";
  }
  if (m.includes("da vinci") || m.includes("mako") || m.includes("rosa") || m.includes("velys") || m.includes("mazor")) {
    return "surgical_robot";
  }
  return "unknown";
}
