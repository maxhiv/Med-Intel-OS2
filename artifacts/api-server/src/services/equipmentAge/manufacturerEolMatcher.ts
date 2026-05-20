/**
 * Manufacturer EOL matcher — joins observed equipment_records to the
 * manufacturer_eol_catalog seeded by Phase B and:
 *
 *   1. Sets `equipment_records.manufacturer_eol_date` and
 *      `manufacturer_support_ended` on the matched row.
 *   2. Emits a `eol_equipment` purchase signal for the facility, with the
 *      successor model in metadata so the bid-draft generator (Phase E)
 *      can suggest an upgrade path.
 *   3. Records an `intelligence_claim` per match so the confidence layer
 *      knows the EOL fact came from the catalog (weight 0.80 per the
 *      handoff's source_weights table).
 *
 * Idempotent — uses `signal_value` to keep the same (model, facility) from
 * re-emitting on subsequent runs, mirroring the medintel signal scorer.
 */
import { and, eq, ilike, isNotNull, sql } from "drizzle-orm";
import {
  db,
  equipmentRecords,
  purchaseSignals,
  manufacturerEolCatalog,
  type InsertSignal,
  type ManufacturerEol,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { ClaimRegistry } from "../confidence/claimRegistry";

const SOURCE = "manufacturer_eol_bulletin";

export interface EolMatchResult {
  recordsScanned: number;
  recordsMatched: number;
  signalsInserted: number;
  claimsRecorded: number;
  errors: number;
}

interface EolKey {
  manufacturer: string;
  model: string;
}

function normaliseKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function eolKey(manufacturer: string | null | undefined, model: string | null | undefined): string {
  return `${normaliseKey(manufacturer)}|${normaliseKey(model)}`;
}

/**
 * Match equipment by exact (manufacturer, model) first; fall back to a
 * looser ILIKE against the model field. Records every successful match.
 */
export async function matchManufacturerEol(): Promise<EolMatchResult> {
  const start = Date.now();
  let errors = 0;

  // Load the entire catalog into memory — at < 100 rows for the foreseeable
  // future it's cheaper than per-equipment queries.
  const catalog = await db.select().from(manufacturerEolCatalog);
  if (catalog.length === 0) {
    logger.warn(
      "manufacturer_eol_catalog is empty; run lib/db/src/scripts/v2_confidence_layer.sql to seed it",
    );
    return {
      recordsScanned: 0,
      recordsMatched: 0,
      signalsInserted: 0,
      claimsRecorded: 0,
      errors: 0,
    };
  }
  const catalogByKey = new Map<string, ManufacturerEol>();
  for (const row of catalog) {
    catalogByKey.set(eolKey(row.manufacturer, row.model), row);
  }

  // Pull equipment records that have at least a manufacturer + model and
  // haven't already been flagged manufacturer_support_ended.
  const records = await db
    .select({
      id: equipmentRecords.id,
      facilityId: equipmentRecords.facilityId,
      manufacturer: equipmentRecords.manufacturer,
      model: equipmentRecords.model,
      modality: equipmentRecords.modality,
      installYear: equipmentRecords.installYear,
      manufacturerEolDate: equipmentRecords.manufacturerEolDate,
    })
    .from(equipmentRecords)
    .where(and(isNotNull(equipmentRecords.manufacturer), isNotNull(equipmentRecords.model)));

  const recordsScanned = records.length;
  let recordsMatched = 0;
  let claimsRecorded = 0;
  const registry = new ClaimRegistry();

  const inserts: Array<InsertSignal & { signalValue: string }> = [];
  const eolUpdates: Array<{
    id: string;
    eolDate: string | null;
    supportEnded: boolean;
  }> = [];

  for (const r of records) {
    try {
      const exact = catalogByKey.get(eolKey(r.manufacturer, r.model));
      let match: ManufacturerEol | undefined = exact;
      if (!match) {
        // Loose ILIKE fallback — handles model strings that include extra
        // descriptors ("Optima CT660 with VolumeShuttle" vs "Optima CT660").
        const found = catalog.find(
          (c) =>
            normaliseKey(c.manufacturer) === normaliseKey(r.manufacturer) &&
            normaliseKey(r.model).startsWith(normaliseKey(c.model)),
        );
        match = found;
      }
      if (!match) continue;
      recordsMatched++;

      const now = new Date();
      const serviceEnd = match.serviceEndDate ? new Date(match.serviceEndDate) : null;
      const supportEnded = serviceEnd ? serviceEnd <= now : false;

      eolUpdates.push({
        id: r.id,
        eolDate: match.serviceEndDate,
        supportEnded,
      });

      // Emit a purchase signal. signal_value carries the catalog row id so
      // re-runs don't double-emit.
      inserts.push({
        facilityId: r.facilityId,
        signalType: "eol_equipment",
        signalValue: `eol:${match.id}:${r.id}`,
        confidence: supportEnded ? 90 : 70,
        source: SOURCE,
        metadata: {
          manufacturer: match.manufacturer,
          modality: match.modality,
          model: match.model,
          generation: match.generation,
          marketReleaseYear: match.marketReleaseYear,
          serviceEndDate: match.serviceEndDate,
          partsEndDate: match.partsEndDate,
          softwareEolDate: match.softwareEolDate,
          successorModel: match.successorModel,
          sourceUrl: match.sourceUrl,
          supportEnded,
          equipmentRecordId: r.id,
          installYear: r.installYear,
        },
      });

      // Record the claim so the confidence layer knows about this fact.
      await registry.record({
        entityTable: "equipment_records",
        entityId: r.id,
        claimField: "manufacturer_eol_date",
        claimValue: match.serviceEndDate ?? "unknown",
        sourceType: SOURCE,
        sourceUrl: match.sourceUrl,
      });
      claimsRecorded++;
    } catch (err) {
      errors++;
      logger.error(
        { err, equipmentRecordId: r.id, facilityId: r.facilityId },
        "EOL match failed for equipment record",
      );
    }
  }

  // Persist the equipment_records EOL fields.
  for (const u of eolUpdates) {
    try {
      await db
        .update(equipmentRecords)
        .set({
          manufacturerEolDate: u.eolDate,
          manufacturerSupportEnded: u.supportEnded,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(equipmentRecords.id, u.id));
    } catch (err) {
      errors++;
      logger.error({ err, id: u.id }, "EOL equipment update failed");
    }
  }

  // De-dupe purchase signal inserts vs. what's already active.
  let signalsInserted = 0;
  if (inserts.length > 0) {
    const existing = await db
      .select({
        facilityId: purchaseSignals.facilityId,
        signalValue: purchaseSignals.signalValue,
      })
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.signalType, "eol_equipment"),
          eq(purchaseSignals.isActive, true),
          eq(purchaseSignals.source, SOURCE),
        ),
      );
    const seen = new Set(
      existing.map((e) => `${e.facilityId}|${e.signalValue ?? ""}`),
    );
    const fresh = inserts.filter(
      (i) => !seen.has(`${i.facilityId}|${i.signalValue}`),
    );
    if (fresh.length > 0) {
      await db.insert(purchaseSignals).values(fresh);
      signalsInserted = fresh.length;
    }
  }

  logger.info(
    {
      recordsScanned,
      recordsMatched,
      signalsInserted,
      claimsRecorded,
      errors,
      ms: Date.now() - start,
    },
    "manufacturer EOL matcher complete",
  );

  return { recordsScanned, recordsMatched, signalsInserted, claimsRecorded, errors };
}

// Helpers kept for follow-up rules.
void ilike;
void sql;
void normaliseKey;
void eolKey;
void ((_: EolKey) => undefined);
