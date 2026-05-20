/**
 * Opportunity Inbox schema (v2.0 Phase E).
 *
 * An opportunity = (facility, modality) + active capital triggers + a
 * decision-maker triangle (clinical champion + economic buyer +
 * procurement gatekeeper). Every Monday morning each rep sees 5–15 of
 * these ranked by readiness in the `/opportunities` page.
 *
 * RLS: opportunities are tenant-scoped per `account_id` and enforced by
 * an `app.account_id` session-var policy (installed by
 * lib/db/src/scripts/v2_opportunity_rls.sql).
 *
 * Pursue / Skip / Snooze / Note / Push-to-GHL actions are logged in the
 * `opportunity_actions` audit trail so reps and managers can see the
 * full pipeline history without leaving the platform.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigserial,
  bigint,
  smallint,
  integer,
  numeric,
  jsonb,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accounts, users } from "./tenant";
import { facilities, facilityContacts, purchaseSignals } from "./intelligence";
import { opportunityStatusEnum, opportunityActionTypeEnum } from "./enums";

// ─── opportunities ───────────────────────────────────────────────────────────
export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    modality: text("modality").notNull(),
    /** Vertical slug (imaging_center, asc, …) at the time of generation,
     *  stored so historical rows survive vertical-module edits. */
    verticalSlug: text("vertical_slug"),
    status: opportunityStatusEnum("status").notNull().default("detected"),
    /** Composite readiness score in [0, 1], per strategic plan §7. */
    readinessScore: numeric("readiness_score", { precision: 5, scale: 4 }),
    /** Component breakdown for the UI's "why this score" panel. */
    scoreBreakdown: jsonb("score_breakdown").notNull().default({}),
    /** Estimated capital dollar range from modality + facility size. */
    estimatedDollarLow: bigint("estimated_dollar_low", { mode: "number" }),
    estimatedDollarHigh: bigint("estimated_dollar_high", { mode: "number" }),
    /** Top-3 active triggers driving this opportunity. */
    primaryTriggerId: uuid("primary_trigger_id"),
    topTriggerIds: uuid("top_trigger_ids").array().default(sql`'{}'`),
    championContactId: uuid("champion_contact_id").references(() => facilityContacts.id, {
      onDelete: "set null",
    }),
    economicBuyerContactId: uuid("economic_buyer_contact_id").references(() => facilityContacts.id, {
      onDelete: "set null",
    }),
    gatekeeperContactId: uuid("gatekeeper_contact_id").references(() => facilityContacts.id, {
      onDelete: "set null",
    }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
    repReviewedAt: timestamp("rep_reviewed_at", { withTimezone: true }),
    repAssignedTo: uuid("rep_assigned_to").references(() => users.id, { onDelete: "set null" }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /** Set when the rep pushes to GHL — the resulting draft/contact id. */
    crmContactId: text("crm_contact_id"),
    crmPushedAt: timestamp("crm_pushed_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // Inbox lookup: latest opportunities for an account, ranked by score.
    index("idx_opportunities_account_status").on(t.accountId, t.status, t.readinessScore),
    index("idx_opportunities_facility").on(t.facilityId, t.modality),
    index("idx_opportunities_rep").on(t.repAssignedTo, t.status),
    // Don't double-generate for the same facility+modality+account in a
    // 90-day window — enforced softly by the generator, hard via this index.
    uniqueIndex("uniq_opportunity_active")
      .on(t.accountId, t.facilityId, t.modality)
      .where(sql`${t.status} IN ('detected', 'rep_reviewed', 'qualified', 'bid_submitted')`),
    check("readiness_score_range", sql`${t.readinessScore} IS NULL OR ${t.readinessScore} BETWEEN 0 AND 1`),
  ],
);

export const insertOpportunitySchema = createInsertSchema(opportunities).omit({
  id: true,
  detectedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type Opportunity = typeof opportunities.$inferSelect;
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;

// ─── opportunity_actions ─────────────────────────────────────────────────────
export const opportunityActions = pgTable(
  "opportunity_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    actionType: opportunityActionTypeEnum("action_type").notNull(),
    performedBy: uuid("performed_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    metadata: jsonb("metadata").default({}),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_opp_actions_opportunity").on(t.opportunityId, t.performedAt),
    index("idx_opp_actions_user").on(t.performedBy, t.performedAt),
  ],
);

export type OpportunityAction = typeof opportunityActions.$inferSelect;

// ─── job_postings ────────────────────────────────────────────────────────────
// Modality-tagged hiring velocity for the behavioural signal engine. The
// daily ingestor (Phase E follow-up) populates this from Adzuna / Jooble /
// USAJobs and tags titles via a static modality dictionary.
export const jobPostings = pgTable(
  "job_postings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "set null" }),
    source: text("source").notNull(), // 'adzuna' | 'jooble' | 'usajobs' | 'company_site'
    sourceJobId: text("source_job_id"),
    title: text("title").notNull(),
    employer: text("employer"),
    location: text("location"),
    modalityTags: text("modality_tags").array().default(sql`'{}'`),
    url: text("url"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_jobs_facility_modality").on(t.facilityId),
    index("idx_jobs_posted").on(t.postedAt),
    uniqueIndex("uniq_jobs_source_id").on(t.source, t.sourceJobId),
  ],
);

export type JobPosting = typeof jobPostings.$inferSelect;

// Silence purchase_signals import — kept for follow-up where opportunity
// rows JOIN purchase_signals by primary_trigger_id directly.
void purchaseSignals;
void smallint;
void integer;
void boolean;
void date;
