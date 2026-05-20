/**
 * Confidence + citation foundation (MedIntel OS v2.0, Phase B).
 *
 * Every fact this platform asserts about a facility / contact / equipment
 * record gets recorded here as an `intelligence_claim` with a source
 * citation and a default-weighted score. The `compute_claim_confidence()`
 * SQL function (installed via lib/db/src/scripts/compute_claim_confidence.sql)
 * collapses N independent observations into a time-decayed confidence
 * value in [0, 1].
 *
 * Two-source-minimum verification:
 *   - A claim is `verified` only when at least 2 distinct source_types
 *     agree AND the decayed sum of their weights >= 0.6.
 *   - Single-source claims surface as `provisional` in the UI.
 *
 * Decay:
 *   - Default half-life: 180 days (encoded in the SQL function).
 *   - Per-claim-type overrides live in confidenceScorer.ts (90 days for
 *     contacts, 365 for equipment install_year).
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  smallint,
  integer,
  date,
  boolean,
  bigserial,
  timestamp,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── source_weights ─────────────────────────────────────────────────────────
// Canonical default-trust table. Source types that aren't listed default to
// 0.40 (the random web scrape floor) — see ClaimRegistry.getDefaultWeight().
export const sourceWeights = pgTable(
  "source_weights",
  {
    sourceType: text("source_type").primaryKey(),
    defaultWeight: numeric("default_weight", { precision: 3, scale: 2 }).notNull(),
    description: text("description"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [check("source_weights_range", sql`${t.defaultWeight} BETWEEN 0 AND 1`)],
);

export const insertSourceWeightSchema = createInsertSchema(sourceWeights).omit({
  createdAt: true,
  updatedAt: true,
});
export type SourceWeight = typeof sourceWeights.$inferSelect;
export type InsertSourceWeight = z.infer<typeof insertSourceWeightSchema>;

// ── intelligence_claims ────────────────────────────────────────────────────
// Generic claim registry. Every ingestor records one row per observation
// here. `entity_id` is intentionally UUID (not BIGINT as in the handoff)
// because every entity table in this repo's schema uses UUID PKs.
export const intelligenceClaims = pgTable(
  "intelligence_claims",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityTable: text("entity_table").notNull(),
    entityId: uuid("entity_id").notNull(),
    claimField: text("claim_field").notNull(),
    claimValue: text("claim_value").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    sourceWeight: numeric("source_weight", { precision: 3, scale: 2 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    contradictedBy: bigserial("contradicted_by", { mode: "number" }).references(
      (): AnyPgColumn => intelligenceClaims.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("idx_claims_entity").on(t.entityTable, t.entityId, t.claimField),
    index("idx_claims_source").on(t.sourceType),
    index("idx_claims_observed").on(t.observedAt),
    check("claims_weight_range", sql`${t.sourceWeight} BETWEEN 0 AND 1`),
  ],
);

export const insertIntelligenceClaimSchema = createInsertSchema(intelligenceClaims).omit({
  id: true,
  observedAt: true,
});
export type IntelligenceClaim = typeof intelligenceClaims.$inferSelect;
export type InsertIntelligenceClaim = z.infer<typeof insertIntelligenceClaimSchema>;

// ── manufacturer_eol_catalog ───────────────────────────────────────────────
// OEM end-of-life knowledge base. Drives:
//   1. manufacturer_eol signals in purchase_signals when a facility's
//      observed equipment_records.model matches a row here.
//   2. successor_model suggestions in bid drafts (Phase E).
// Composite uniqueness on (manufacturer, modality, model) so OEMs can revise.
export const manufacturerEolCatalog = pgTable(
  "manufacturer_eol_catalog",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    manufacturer: text("manufacturer").notNull(),
    modality: text("modality").notNull(),
    model: text("model").notNull(),
    generation: text("generation"),
    marketReleaseYear: integer("market_release_year"),
    serviceEndDate: date("service_end_date"),
    partsEndDate: date("parts_end_date"),
    softwareEolDate: date("software_eol_date"),
    successorModel: text("successor_model"),
    sourceUrl: text("source_url"),
    sourceExcerpt: text("source_excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_eol_catalog").on(t.manufacturer, t.modality, t.model),
    index("idx_eol_modality").on(t.modality),
    index("idx_eol_service_end").on(t.serviceEndDate),
  ],
);

export const insertManufacturerEolSchema = createInsertSchema(manufacturerEolCatalog).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ManufacturerEol = typeof manufacturerEolCatalog.$inferSelect;
export type InsertManufacturerEol = z.infer<typeof insertManufacturerEolSchema>;

// ── equipment_source_citations ─────────────────────────────────────────────
// Multi-source attribution per equipment_records row. Joins to the v1
// equipment_records table by UUID. Lets the UI show "this CT install year
// confirmed by: TX radiation registry + GE EOL bulletin + HCRIS A-7".
export const equipmentSourceCitations = pgTable(
  "equipment_source_citations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    equipmentRecordId: uuid("equipment_record_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    sourceExcerpt: text("source_excerpt"),
    observedInstallYear: smallint("observed_install_year"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow(),
    weight: numeric("weight", { precision: 3, scale: 2 }).default("0.50"),
  },
  (t) => [
    index("idx_equip_citations_record").on(t.equipmentRecordId),
    index("idx_equip_citations_source").on(t.sourceType),
    check("equip_citations_weight_range", sql`${t.weight} BETWEEN 0 AND 1`),
  ],
);

export type EquipmentSourceCitation = typeof equipmentSourceCitations.$inferSelect;

// Note on FK to equipment_records:
//   `equipment_records.id` lives in intelligence.ts; declaring the FK there
//   would create a circular import. We assert the constraint via a separate
//   SQL script (lib/db/src/scripts/equipment_citations_fk.sql) so the
//   schema TypeScript stays acyclic. The UUID type ensures referential
//   integrity even before the FK is materialized.
