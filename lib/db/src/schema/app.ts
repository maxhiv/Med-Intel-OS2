/**
 * Sales-rep workspace schema — the "app.*" surface from the Medintel OS
 * brief. Tables live in the default `public` schema (with explicit names) so
 * they participate in the same Row-Level Security model as the rest of the
 * app; the medintel warehouse stays read-only in its own schema.
 *
 * Tables:
 *   - territories                Saved filter + view kind (buy / sell side)
 *   - equipment_line_profiles    Per-line scoring rubrics (system + custom)
 *   - account_territory_favorites Per-account starring of system territories
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accounts, users } from "./tenant";
import { facilities } from "./intelligence";

// ─── Territory filter shape (stored as JSONB) ────────────────────────────────
// Documented in TerritoryFilter / SellSideFilter zod schemas in the API; the
// DB just stores whatever the API validates.

export const territories = pgTable(
  "territories",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** 'buy_side' (default) or 'sell_side'. Sell-side preloads declining-HCRIS
     *  + seller-CHOW conditions when the territory is evaluated. */
    viewKind: text("view_kind").notNull().default("buy_side"),
    name: text("name").notNull(),
    description: text("description"),
    /** TerritoryFilter shape — see `territoryService.ts`. */
    filter: jsonb("filter").notNull().default({}),
    /** Optional locked equipment-line profile slug. Null = no equipment lens. */
    equipmentLineSlug: text("equipment_line_slug"),
    isShared: boolean("is_shared").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_territories_account").on(t.accountId, t.viewKind),
    index("idx_territories_account_name").on(t.accountId, t.name),
  ],
);

export const insertTerritorySchema = createInsertSchema(territories).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Territory = typeof territories.$inferSelect;
export type InsertTerritory = z.infer<typeof insertTerritorySchema>;

export const equipmentLineProfiles = pgTable(
  "equipment_line_profiles",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    /** Stable code, e.g. 'imaging', 'surgical'. Used by the URL and by
     *  Territory.equipment_line_slug. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Null for the seeded system profiles; set for account customizations. */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    /** Marks the seeded "Medintel default" rubrics. */
    isSystem: boolean("is_system").notNull().default(false),
    /** Bridge to a vertical_modules.slug, when this line is naturally aligned
     *  with one customer vertical (imaging-equipment → imaging_center vertical,
     *  surgical → asc/orthopedic, etc.). NULL means the line spans verticals. */
    verticalSlug: text("vertical_slug"),
    /** Scoring rubric — see `equipmentLineService.ts` for shape. */
    rubric: jsonb("rubric").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // System rubric per slug must be unique; per-account rubrics get their own row.
    uniqueIndex("uniq_equip_line_system_slug")
      .on(t.slug)
      .where(sql`${t.isSystem} = TRUE`),
    index("idx_equip_line_account_slug").on(t.accountId, t.slug),
    index("idx_equip_line_vertical").on(t.verticalSlug),
  ],
);

export const insertEquipmentLineProfileSchema = createInsertSchema(
  equipmentLineProfiles,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type EquipmentLineProfile = typeof equipmentLineProfiles.$inferSelect;
export type InsertEquipmentLineProfile = z.infer<typeof insertEquipmentLineProfileSchema>;

// ─── vertical_modules ────────────────────────────────────────────────────────
// Per-vertical scoring weights, playbooks, and signal subsets. A "vertical"
// describes the *customer* (imaging center, ASC, rural hospital, …) — distinct
// from an equipment_line_profile, which describes the *product the rep sells*
// (imaging equipment, surgical, monitoring, …). The two link via
// equipment_line_profiles.vertical_slug.
export const verticalModules = pgTable(
  "vertical_modules",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    /** Modalities this vertical typically buys (MRI, CT, surgical_robot, …). */
    primaryModalities: text("primary_modalities").array().notNull().default(sql`'{}'`),
    /** facilities.facility_type values that should auto-map to this vertical. */
    facilityTypeFilter: text("facility_type_filter").array().notNull().default(sql`'{}'`),
    /** signal_type → weight overrides for the vertical (vs. the global
     *  WEIGHTS table in signalScorer). Stored as JSONB so account admins can
     *  tune without a deploy. */
    signalWeights: jsonb("signal_weights").notNull().default({}),
    /** Optional handle to a default outreach sequence used by the vertical
     *  playbook (Phase E). */
    outreachSequenceId: uuid("outreach_sequence_id"),
    /** Optional handle to a default report template used by the playbook. */
    reportTemplate: text("report_template"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
);

export const insertVerticalModuleSchema = createInsertSchema(verticalModules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type VerticalModule = typeof verticalModules.$inferSelect;
export type InsertVerticalModule = z.infer<typeof insertVerticalModuleSchema>;

// ─── facility_vertical_map ───────────────────────────────────────────────────
// Per-facility vertical assignment. One facility can map to multiple verticals
// (e.g. a hospital with an outpatient imaging line + an ASC line). At most one
// is_primary = TRUE per facility, enforced by the orchestrator service.
export const facilityVerticalMap = pgTable(
  "facility_vertical_map",
  {
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    verticalId: uuid("vertical_id")
      .notNull()
      .references(() => verticalModules.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.facilityId, t.verticalId] }),
    index("idx_fvm_facility").on(t.facilityId),
    index("idx_fvm_vertical").on(t.verticalId),
    uniqueIndex("uniq_fvm_primary")
      .on(t.facilityId)
      .where(sql`${t.isPrimary} = TRUE`),
  ],
);

export type FacilityVerticalMap = typeof facilityVerticalMap.$inferSelect;
