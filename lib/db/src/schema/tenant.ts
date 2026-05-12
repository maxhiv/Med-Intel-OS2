import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { planTierEnum, crmTypeEnum, enrichmentSourceEnum } from "./enums";
import { facilities, facilityContacts } from "./intelligence";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  planTier: planTierEnum("plan_tier").default("starter"),
  defaultCrm: crmTypeEnum("default_crm").default("ghl"),
  batchLimitDaily: integer("batch_limit_daily").default(10),
  status: text("status").default("trial"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  settings: jsonb("settings").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Account = typeof accounts.$inferSelect;
export type InsertAccount = z.infer<typeof insertAccountSchema>;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").references(() => accounts.id),
    clerkUserId: text("clerk_user_id").unique(),
    email: text("email").notNull().unique(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    role: text("role").notNull(),
    isActive: boolean("is_active").default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_users_account").on(t.accountId), index("idx_users_email").on(t.email)],
);

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export const enrichmentSourceApprovals = pgTable("enrichment_source_approvals", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  source: enrichmentSourceEnum("source").notNull().unique(),
  approved: boolean("approved").default(false),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  notes: text("notes"),
  monthlyBudgetLimit: bigint("monthly_budget_limit", { mode: "number" }),
  currentMonthSpend: bigint("current_month_spend", { mode: "number" }).default(0),
  /**
   * UTC timestamp marking the start of the billing month that
   * `currentMonthSpend` is currently accumulating into. When the live clock
   * crosses into a new calendar month, the rollover routine archives the
   * accumulated spend to `enrichment_source_spend_history`, zeros
   * `currentMonthSpend`, and advances this pointer.
   */
  spendPeriodStart: timestamp("spend_period_start", { withTimezone: true })
    .notNull()
    .default(sql`date_trunc('month', now())`),
  lastResetAt: timestamp("last_reset_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type EnrichmentSourceApproval = typeof enrichmentSourceApprovals.$inferSelect;

/**
 * Archive of `enrichment_source_approvals.current_month_spend` per closed
 * billing month. Written by the month-rollover routine so historical totals
 * survive after the live counter is reset to 0.
 */
export const enrichmentSourceSpendHistory = pgTable(
  "enrichment_source_spend_history",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    source: enrichmentSourceEnum("source").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    totalSpendMicros: bigint("total_spend_micros", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_spend_history_source_period").on(t.source, t.periodStart),
    index("idx_spend_history_source").on(t.source),
  ],
);

export type EnrichmentSourceSpendHistory =
  typeof enrichmentSourceSpendHistory.$inferSelect;

export const subAccounts = pgTable(
  "sub_accounts",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    crmType: crmTypeEnum("crm_type"),
    crmCredentials: jsonb("crm_credentials").default({}),
    crmSubId: text("crm_sub_id"),
    batchSizeDaily: integer("batch_size_daily").default(10),
    batchWarmupMode: boolean("batch_warmup_mode").default(true),
    repUserId: uuid("rep_user_id").references(() => users.id),
    repName: text("rep_name"),
    repEmail: text("rep_email"),
    timezone: text("timezone").default("America/Chicago"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_sub_accounts_account").on(t.accountId)],
);

export const insertSubAccountSchema = createInsertSchema(subAccounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type SubAccount = typeof subAccounts.$inferSelect;
export type InsertSubAccount = z.infer<typeof insertSubAccountSchema>;

/**
 * Audit trail for CRM credential encryption-key rotations. One row per
 * sub-account touched by a rotation run (`runId` groups them). Lets ops
 * answer "when was this row last re-encrypted, by whom, with which key?"
 * without exposing any plaintext or key material.
 */
export const crmKeyRotationEvents = pgTable(
  "crm_key_rotation_events",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    runId: uuid("run_id").notNull(),
    subAccountId: uuid("sub_account_id").references(() => subAccounts.id, {
      onDelete: "set null",
    }),
    /** "re_encrypted" | "already_current" | "skipped_plaintext" | "failed" */
    status: text("status").notNull(),
    /** Short fingerprint (first 8 hex chars of sha256(key)) of the key that decrypted the blob. */
    fromKid: text("from_kid"),
    /** Short fingerprint of the new primary key the blob was re-encrypted under. */
    toKid: text("to_kid"),
    /** Was decryption performed with the fallback CRM_ENCRYPTION_KEY_PREVIOUS? */
    decryptedWithPrevious: boolean("decrypted_with_previous").default(false),
    dryRun: boolean("dry_run").default(false),
    errorMessage: text("error_message"),
    performedBy: uuid("performed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_crm_key_rotation_run").on(t.runId),
    index("idx_crm_key_rotation_sub").on(t.subAccountId),
    index("idx_crm_key_rotation_created").on(t.createdAt),
  ],
);

export type CrmKeyRotationEvent = typeof crmKeyRotationEvents.$inferSelect;

export const accountFacilities = pgTable(
  "account_facilities",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    facilityId: uuid("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    subAccountId: uuid("sub_account_id").references(() => subAccounts.id),
    status: text("status").default("identified"),
    priority: smallint("priority").default(5),
    dealScore: smallint("deal_score").default(0),
    engagementScore: smallint("engagement_score").default(0),
    notes: text("notes"),
    tags: text("tags").array().default(sql`'{}'`),
    crmCompanyId: text("crm_company_id"),
    crmDealId: text("crm_deal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_acct_facility").on(t.accountId, t.facilityId),
    index("idx_acct_facilities_account").on(t.accountId, t.status),
    index("idx_acct_facilities_sub").on(t.subAccountId),
  ],
);

export const insertAccountFacilitySchema = createInsertSchema(accountFacilities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type AccountFacility = typeof accountFacilities.$inferSelect;
export type InsertAccountFacility = z.infer<typeof insertAccountFacilitySchema>;

// Per-tenant engagement score for individual contacts. Contacts themselves are
// global rows (a clinician at Acme Health is the same person regardless of
// which sub-account is working them), but engagement (replies, opens, bounces)
// is account-specific outreach data and must not leak across tenants.
export const accountContactEngagement = pgTable(
  "account_contact_engagement",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull(),
    engagementScore: smallint("engagement_score").default(0),
    repliesCount: smallint("replies_count").default(0),
    bouncesCount: smallint("bounces_count").default(0),
    opensCount: smallint("opens_count").default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_acct_contact_eng").on(t.accountId, t.contactId),
    index("idx_acct_contact_eng_account").on(t.accountId),
  ],
);

export type AccountContactEngagement = typeof accountContactEngagement.$inferSelect;

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    subAccountId: uuid("sub_account_id").notNull().references(() => subAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    filterCriteria: jsonb("filter_criteria").default({}),
    batchSizeDaily: integer("batch_size_daily").default(10),
    status: text("status").default("draft"),
    startDate: timestamp("start_date", { withTimezone: false, mode: "string" }),
    endDate: timestamp("end_date", { withTimezone: false, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_campaigns_account").on(t.accountId, t.status),
    index("idx_campaigns_sub").on(t.subAccountId),
  ],
);

export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;

export const campaignContacts = pgTable(
  "campaign_contacts",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    contactId: uuid("contact_id").notNull().references(() => facilityContacts.id),
    score: smallint("score").default(0),
    sequenceId: uuid("sequence_id"),
    status: text("status").default("queued"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    crmContactId: text("crm_contact_id"),
    crmSyncedAt: timestamp("crm_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_campaign_contact").on(t.campaignId, t.contactId),
    index("idx_cc_campaign").on(t.campaignId, t.status),
    index("idx_cc_account").on(t.accountId),
  ],
);

export const insertCampaignContactSchema = createInsertSchema(campaignContacts).omit({
  id: true,
  createdAt: true,
});
export type CampaignContact = typeof campaignContacts.$inferSelect;
export type InsertCampaignContact = z.infer<typeof insertCampaignContactSchema>;
