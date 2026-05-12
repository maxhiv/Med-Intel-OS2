import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  timestamp,
  date,
  jsonb,
  char,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  outreachChannelEnum,
  enrollmentStatusEnum,
  draftStatusEnum,
  syncStatusEnum,
  crmTypeEnum,
  reportStatusEnum,
} from "./enums";
import { accounts, users, campaigns, campaignContacts, subAccounts } from "./tenant";
import { facilities, facilityContacts } from "./intelligence";

export const sequences = pgTable(
  "sequences",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    name: text("name").notNull(),
    description: text("description"),
    channel: outreachChannelEnum("channel").default("email"),
    totalSteps: smallint("total_steps").default(0),
    isAiGenerated: boolean("is_ai_generated").default(false),
    templateVars: jsonb("template_vars").default({}),
    isActive: boolean("is_active").default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_sequences_account").on(t.accountId)],
);

export const insertSequenceSchema = createInsertSchema(sequences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Sequence = typeof sequences.$inferSelect;
export type InsertSequence = z.infer<typeof insertSequenceSchema>;

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
    stepNum: smallint("step_num").notNull(),
    channel: outreachChannelEnum("channel").default("email"),
    delayDays: smallint("delay_days").default(0),
    subjectLine: text("subject_line"),
    bodyTemplate: text("body_template"),
    linkedinNote: text("linkedin_note"),
    linkedinMessage: text("linkedin_message"),
    personalizationHooks: jsonb("personalization_hooks").default({}),
    variant: char("variant", { length: 1 }).default("A"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_seq_step_variant").on(t.sequenceId, t.stepNum, t.variant),
    index("idx_steps_sequence").on(t.sequenceId, t.stepNum),
  ],
);

export const insertSequenceStepSchema = createInsertSchema(sequenceSteps).omit({
  id: true,
  createdAt: true,
});
export type SequenceStep = typeof sequenceSteps.$inferSelect;
export type InsertSequenceStep = z.infer<typeof insertSequenceStepSchema>;

export const contactEnrollments = pgTable(
  "contact_enrollments",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    campaignContactId: uuid("campaign_contact_id").notNull().references(() => campaignContacts.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id").notNull().references(() => sequences.id),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    currentStep: smallint("current_step").default(0),
    status: enrollmentStatusEnum("status").default("active"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).defaultNow(),
    lastStepAt: timestamp("last_step_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    replyReceivedAt: timestamp("reply_received_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_enrollments_cc").on(t.campaignContactId),
    index("idx_enrollments_status").on(t.status, t.accountId),
  ],
);

export type ContactEnrollment = typeof contactEnrollments.$inferSelect;

export const outreachDrafts = pgTable(
  "outreach_drafts",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    enrollmentId: uuid("enrollment_id").references(() => contactEnrollments.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => sequenceSteps.id),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    contactId: uuid("contact_id").notNull().references(() => facilityContacts.id),
    facilityId: uuid("facility_id").notNull().references(() => facilities.id),
    channel: outreachChannelEnum("channel").default("email"),
    subject: text("subject"),
    body: text("body").notNull(),
    linkedinNote: text("linkedin_note"),
    linkedinMessage: text("linkedin_message"),
    personalizationApplied: jsonb("personalization_applied").default({}),
    aiModel: text("ai_model"),
    aiPromptVersion: text("ai_prompt_version"),
    generationTokens: integer("generation_tokens"),
    status: draftStatusEnum("status").default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    crmDraftId: text("crm_draft_id"),
    crmSyncedAt: timestamp("crm_synced_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_drafts_account").on(t.accountId, t.status),
    index("idx_drafts_contact").on(t.contactId),
    index("idx_drafts_enrollment").on(t.enrollmentId),
  ],
);

export const insertDraftSchema = createInsertSchema(outreachDrafts).omit({
  id: true,
  generatedAt: true,
});
export type OutreachDraft = typeof outreachDrafts.$inferSelect;
export type InsertOutreachDraft = z.infer<typeof insertDraftSchema>;

export const draftEdits = pgTable(
  "draft_edits",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    draftId: uuid("draft_id").notNull().references(() => outreachDrafts.id, { onDelete: "cascade" }),
    editedBy: uuid("edited_by").references(() => users.id),
    fieldChanged: text("field_changed"),
    originalValue: text("original_value"),
    newValue: text("new_value"),
    editReason: text("edit_reason"),
    editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_draft_edits_draft").on(t.draftId)],
);

export const syncBatches = pgTable(
  "sync_batches",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    subAccountId: uuid("sub_account_id").notNull().references(() => subAccounts.id),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    crmType: crmTypeEnum("crm_type").notNull(),
    batchDate: date("batch_date").notNull(),
    targetCount: integer("target_count").default(0),
    pushedCount: integer("pushed_count").default(0),
    failedCount: integer("failed_count").default(0),
    status: syncStatusEnum("status").default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorLog: jsonb("error_log").default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_batches_account").on(t.accountId, t.batchDate),
    index("idx_batches_status").on(t.status),
  ],
);

export type SyncBatch = typeof syncBatches.$inferSelect;

export const syncItems = pgTable(
  "sync_items",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    batchId: uuid("batch_id").notNull().references(() => syncBatches.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    entityType: text("entity_type"),
    localId: uuid("local_id").notNull(),
    crmId: text("crm_id"),
    crmType: crmTypeEnum("crm_type"),
    crmResponse: jsonb("crm_response"),
    status: text("status").default("pending"),
    errorMessage: text("error_message"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    retryCount: smallint("retry_count").default(0),
  },
  (t) => [index("idx_sync_items_batch").on(t.batchId, t.status)],
);

export const crmContactsMap = pgTable(
  "crm_contacts_map",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    localContactId: uuid("local_contact_id").notNull().references(() => facilityContacts.id),
    crmType: crmTypeEnum("crm_type").notNull(),
    crmContactId: text("crm_contact_id").notNull(),
    crmCompanyId: text("crm_company_id"),
    crmDealId: text("crm_deal_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_crm_map").on(t.accountId, t.localContactId, t.crmType),
    index("idx_crm_map_account").on(t.accountId, t.crmType),
  ],
);

export const replyEvents = pgTable(
  "reply_events",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    draftId: uuid("draft_id").references(() => outreachDrafts.id),
    crmType: crmTypeEnum("crm_type"),
    crmContactId: text("crm_contact_id"),
    eventType: text("event_type"),
    rawPayload: jsonb("raw_payload"),
    aiClassification: text("ai_classification"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_reply_events_account").on(t.accountId, t.receivedAt),
    index("idx_reply_events_draft").on(t.draftId),
  ],
);

export const reportTemplates = pgTable(
  "report_templates",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id").references(() => accounts.id),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    dataSources: text("data_sources").array().notNull(),
    fieldConfig: jsonb("field_config").notNull().default([]),
    filterConfig: jsonb("filter_config").notNull().default([]),
    sortConfig: jsonb("sort_config").default({}),
    vizType: text("viz_type").default("table"),
    exportFormats: text("export_formats").array().default(sql`ARRAY['pdf','csv','xlsx']::text[]`),
    schedulable: boolean("schedulable").default(true),
    crmAttachable: boolean("crm_attachable").default(false),
    isSystemTemplate: boolean("is_system_template").default(false),
    isActive: boolean("is_active").default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_report_templates_account").on(t.accountId, t.category)],
);

export const insertReportTemplateSchema = createInsertSchema(reportTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ReportTemplate = typeof reportTemplates.$inferSelect;
export type InsertReportTemplate = z.infer<typeof insertReportTemplateSchema>;

export const reportRuns = pgTable(
  "report_runs",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    templateId: uuid("template_id").notNull().references(() => reportTemplates.id),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    triggeredBy: text("triggered_by").default("manual"),
    triggeredByUser: uuid("triggered_by_user").references(() => users.id),
    runtimeFilters: jsonb("runtime_filters").default({}),
    status: reportStatusEnum("status").default("queued"),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("idx_report_runs_account").on(t.accountId, t.queuedAt)],
);

export type ReportRun = typeof reportRuns.$inferSelect;

export const reportOutputs = pgTable("report_outputs", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  runId: uuid("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  format: text("format").notNull(),
  storagePath: text("storage_path").notNull(),
  fileSizeKb: integer("file_size_kb"),
  downloadUrl: text("download_url"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).default(sql`NOW() + INTERVAL '7 days'`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    templateId: uuid("template_id").notNull().references(() => reportTemplates.id),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone").default("America/Chicago"),
    recipients: text("recipients").array().default(sql`'{}'`),
    crmAttach: boolean("crm_attach").default(false),
    exportFormat: text("export_format").default("pdf"),
    isActive: boolean("is_active").default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references(() => reportRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_report_schedules_next").on(t.isActive, t.nextRunAt)],
);

export const insertReportScheduleSchema = createInsertSchema(reportSchedules).omit({
  id: true,
  createdAt: true,
});
export type ReportSchedule = typeof reportSchedules.$inferSelect;
export type InsertReportSchedule = z.infer<typeof insertReportScheduleSchema>;
