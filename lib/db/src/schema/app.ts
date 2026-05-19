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
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accounts, users } from "./tenant";

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
