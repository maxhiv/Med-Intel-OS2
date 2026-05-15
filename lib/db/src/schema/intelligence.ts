import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  smallint,
  bigint,
  numeric,
  boolean,
  timestamp,
  date,
  jsonb,
  char,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  ownershipTypeEnum,
  signalTypeEnum,
  contactStatusEnum,
  enrichmentSourceEnum,
} from "./enums";

export const facilities = pgTable(
  "facilities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    npi: varchar("npi", { length: 10 }).notNull().unique(),
    name: text("name").notNull(),
    doingBusinessAs: text("doing_business_as"),
    facilityType: text("facility_type").notNull(),
    cmsId: text("cms_id"),
    beds: integer("beds"),
    ownership: ownershipTypeEnum("ownership").default("unknown"),
    systemName: text("system_name"),
    idnId: uuid("idn_id"),
    address1: text("address1"),
    city: text("city"),
    state: char("state", { length: 2 }),
    zip: varchar("zip", { length: 10 }),
    county: text("county"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    website: text("website"),
    cahDesignation: boolean("cah_designation").default(false),
    dshPct: numeric("dsh_pct", { precision: 5, scale: 2 }),
    scpDesignation: boolean("scp_designation").default(false),
    fqhcDesignation: boolean("fqhc_designation").default(false),
    teachingHospital: boolean("teaching_hospital").default(false),
    gmeSlots: integer("gme_slots"),
    parentSystemId: uuid("parent_system_id").references(
      (): AnyPgColumn => facilities.id,
      { onDelete: "set null" },
    ),
    fiscalYearEndMonth: integer("fiscal_year_end_month"),
    fiscalYearEndSource: text("fiscal_year_end_source"),
    signalScore: smallint("signal_score").default(0),
    lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
    lastEnrichedAt: timestamp("last_enriched_at", { withTimezone: true }),
    scrapeErrors: integer("scrape_errors").default(0),
    ein: varchar("ein", { length: 9 }),
    einSource: text("ein_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_facilities_state").on(t.state),
    index("idx_facilities_ein").on(t.ein),
    index("idx_facilities_type").on(t.facilityType),
    index("idx_facilities_signal_score").on(t.signalScore),
    // Trigram GIN indexes power the CON ingestor's candidate-pool ILIKE
    // probes against name / DBA / system_name. Requires the `pg_trgm`
    // extension, which is created before schema push by
    // `lib/db/src/ensure-extensions.ts` (and re-asserted by `seed.ts`).
    index("idx_facilities_name_trgm")
      .using("gin", sql`${t.name} gin_trgm_ops`),
    index("idx_facilities_dba_trgm")
      .using("gin", sql`${t.doingBusinessAs} gin_trgm_ops`),
    index("idx_facilities_system_name_trgm")
      .using("gin", sql`${t.systemName} gin_trgm_ops`),
    check("signal_score_range", sql`${t.signalScore} BETWEEN 0 AND 100`),
  ],
);

export const insertFacilitySchema = createInsertSchema(facilities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Facility = typeof facilities.$inferSelect;
export type InsertFacility = z.infer<typeof insertFacilitySchema>;

export const financialDocuments = pgTable(
  "financial_documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    fiscalYear: smallint("fiscal_year").notNull(),
    sourceUrl: text("source_url"),
    rawText: text("raw_text"),
    parsedJson: jsonb("parsed_json"),
    totalRevenue: bigint("total_revenue", { mode: "number" }),
    operatingIncome: bigint("operating_income", { mode: "number" }),
    operatingMarginPct: numeric("operating_margin_pct", { precision: 6, scale: 2 }),
    capitalExpenditures: bigint("capital_expenditures", { mode: "number" }),
    longTermDebt: bigint("long_term_debt", { mode: "number" }),
    daysCashOnHand: numeric("days_cash_on_hand", { precision: 8, scale: 2 }),
    netPatientRevenue: bigint("net_patient_revenue", { mode: "number" }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_fin_docs").on(t.facilityId, t.docType, t.fiscalYear),
    index("idx_fin_docs_facility").on(t.facilityId, t.fiscalYear),
  ],
);

export const equipmentRecords = pgTable(
  "equipment_records",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    modality: text("modality").notNull(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    installYear: smallint("install_year"),
    originalCost: bigint("original_cost", { mode: "number" }),
    bookValue: bigint("book_value", { mode: "number" }),
    accumDepreciation: bigint("accum_depreciation", { mode: "number" }),
    pctDepreciated: numeric("pct_depreciated", { precision: 5, scale: 2 }),
    estReplacementYear: smallint("est_replacement_year"),
    urgencyTier: text("urgency_tier").default("unknown"),
    registrationNumber: text("registration_number"),
    registrationDate: date("registration_date"),
    lastInspectionDate: date("last_inspection_date"),
    registrationExpiry: date("registration_expiry"),
    sourceDocId: uuid("source_doc_id").references(() => financialDocuments.id),
    sourceType: text("source_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_equip_facility").on(t.facilityId),
    index("idx_equip_modality").on(t.modality),
    index("idx_equip_urgency").on(t.urgencyTier),
  ],
);

export const insertEquipmentSchema = createInsertSchema(equipmentRecords).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Equipment = typeof equipmentRecords.$inferSelect;
export type InsertEquipment = z.infer<typeof insertEquipmentSchema>;

export const purchaseSignals = pgTable(
  "purchase_signals",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    signalType: signalTypeEnum("signal_type").notNull(),
    signalValue: text("signal_value"),
    confidence: smallint("confidence").default(50),
    source: text("source").notNull(),
    sourceId: uuid("source_id"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").default(true),
    sourceUrl: text("source_url"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("idx_signals_facility").on(t.facilityId, t.isActive),
    index("idx_signals_type").on(t.signalType),
    index("idx_signals_detected").on(t.detectedAt),
  ],
);

export const insertSignalSchema = createInsertSchema(purchaseSignals).omit({
  id: true,
  detectedAt: true,
});
export type Signal = typeof purchaseSignals.$inferSelect;
export type InsertSignal = z.infer<typeof insertSignalSchema>;

export const conFilings = pgTable(
  "con_filings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id").references(() => facilities.id),
    state: char("state", { length: 2 }).notNull(),
    filingDate: date("filing_date"),
    decisionDate: date("decision_date"),
    equipmentType: text("equipment_type"),
    modality: text("modality"),
    requestedAmount: bigint("requested_amount", { mode: "number" }),
    approvedAmount: bigint("approved_amount", { mode: "number" }),
    status: text("status"),
    applicantName: text("applicant_name"),
    filingUrl: text("filing_url"),
    notes: text("notes"),
    /** Confidence in [0,1] from the fuzzy facility matcher; 1 for exact NPI matches, null when unmatched. */
    matchScore: numeric("match_score", { precision: 4, scale: 3 }),
    /** Which facility column carried the match: name | dba | system | npi. Null when unmatched. */
    matchField: text("match_field"),
    /**
     * Human-review state for the auto-emitted facility match:
     *   auto_approved — high-confidence (NPI or score >= review threshold), no review needed
     *   needs_review  — borderline match in the configurable review band
     *   confirmed     — reviewer approved the match
     *   rejected      — reviewer rejected the match (auto-emitted signal is deactivated)
     *   reassigned    — reviewer swapped to a different facility (old signal deactivated, new emitted)
     * Null when the filing has no matched facility.
     */
    reviewStatus: text("review_status"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    reviewNotes: text("review_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // Hard idempotency guarantee for the CON ingestor under concurrent runs.
    uniqueIndex("uniq_con_filings_state_url").on(t.state, t.filingUrl),
    index("idx_con_filings_facility").on(t.facilityId),
    // Lets the admin review queue scan only borderline rows cheaply.
    index("idx_con_filings_review_status").on(t.reviewStatus),
  ],
);

export const facilityContacts = pgTable(
  "facility_contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    title: text("title"),
    department: text("department"),
    npi: varchar("npi", { length: 10 }),
    email: text("email"),
    emailStatus: contactStatusEnum("email_status").default("unverified"),
    emailConfidence: smallint("email_confidence").default(0),
    phone: text("phone"),
    phoneType: text("phone_type"),
    phoneValid: boolean("phone_valid"),
    linkedinUrl: text("linkedin_url"),
    linkedinData: jsonb("linkedin_data"),
    linkedinLastActivity: timestamp("linkedin_last_activity", { withTimezone: true }),
    confidenceScore: smallint("confidence_score").default(0),
    doximityVerified: boolean("doximity_verified").default(false),
    cmsBillingVerified: boolean("cms_billing_verified").default(false),
    humanVerified: boolean("human_verified").default(false),
    humanVerifiedAt: timestamp("human_verified_at", { withTimezone: true }),
    humanVerifiedBy: uuid("human_verified_by"),
    buyingAuthorityScore: smallint("buying_authority_score").default(0),
    dataSource: text("data_source"),
    lastEnrichedAt: timestamp("last_enriched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_contacts_facility").on(t.facilityId),
    index("idx_contacts_confidence").on(t.confidenceScore),
  ],
);

export const insertContactSchema = createInsertSchema(facilityContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Contact = typeof facilityContacts.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;

export const facilityNews = pgTable(
  "facility_news",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    headline: text("headline").notNull(),
    summary: text("summary"),
    sourceUrl: text("source_url"),
    sourceName: text("source_name"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    rawContent: text("raw_content"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_news_facility").on(t.facilityId, t.publishedAt)],
);

export const facilityProcurement = pgTable("facility_procurement", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  gpoName: text("gpo_name"),
  gpoTier: text("gpo_tier"),
  idnSystem: text("idn_system"),
  vacCadence: text("vac_cadence"),
  fiscalYearEnd: text("fiscal_year_end"),
  capitalThresholdBoard: bigint("capital_threshold_board", { mode: "number" }),
  capitalThresholdCfo: bigint("capital_threshold_cfo", { mode: "number" }),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityClinicalVolume = pgTable(
  "facility_clinical_volume",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id").notNull().references(() => facilities.id, { onDelete: "cascade" }),
    cmsYear: smallint("cms_year").notNull(),
    annualCtVolume: integer("annual_ct_volume"),
    annualMriVolume: integer("annual_mri_volume"),
    annualPetVolume: integer("annual_pet_volume"),
    annualXrayVolume: integer("annual_xray_volume"),
    annualNuclearMedVolume: integer("annual_nuclear_med_volume"),
    caseMixIndex: numeric("case_mix_index", { precision: 5, scale: 2 }),
    traumaLevel: smallint("trauma_level"),
    inpatientDischarges: integer("inpatient_discharges"),
    outpatientVisits: integer("outpatient_visits"),
  },
  (t) => [uniqueIndex("uniq_clinical_volume").on(t.facilityId, t.cmsYear)],
);

export const facilityTechStack = pgTable("facility_tech_stack", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  ehrVendor: text("ehr_vendor"),
  ehrGoLiveDate: date("ehr_go_live_date"),
  pacsVendor: text("pacs_vendor"),
  risVendor: text("ris_vendor"),
  himssEmramScore: smallint("himss_emram_score"),
  teleradiologyPartner: text("teleradiology_partner"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityAccreditation = pgTable("facility_accreditation", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  jcAccredited: boolean("jc_accredited").default(false),
  jcLastSurveyDate: date("jc_last_survey_date"),
  jcNextSurveyEst: date("jc_next_survey_est"),
  acrLastAccredDate: date("acr_last_accred_date"),
  acrRenewalEst: date("acr_renewal_est"),
  leapfrogGrade: char("leapfrog_grade", { length: 1 }),
  cmsStarRating: smallint("cms_star_rating"),
  magnetDesignation: boolean("magnet_designation").default(false),
  mqsaCertDate: date("mqsa_cert_date"),
  nrcLicenseNumber: text("nrc_license_number"),
  nrcLicenseExpiry: date("nrc_license_expiry"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityWorkforce = pgTable("facility_workforce", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  activeImagingJobPosts: integer("active_imaging_job_posts").default(0),
  radiologyDirOpen: boolean("radiology_dir_open").default(false),
  csuiteChanges: jsonb("csuite_changes").default([]),
  fteTotal: integer("fte_total"),
  fteYoyDelta: numeric("fte_yoy_delta", { precision: 6, scale: 2 }),
  biomedFteCount: integer("biomed_fte_count"),
  lastJobScrapeAt: timestamp("last_job_scrape_at", { withTimezone: true }),
});

export const facilityResearch = pgTable("facility_research", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  activeTrialsCount: integer("active_trials_count").default(0),
  activeTrialsImaging: jsonb("active_trials_imaging").default([]),
  nihGrantsActive: integer("nih_grants_active").default(0),
  nihGrantTotalValue: bigint("nih_grant_total_value", { mode: "number" }),
  hrsaGrantsActive: integer("hrsa_grants_active").default(0),
  gmeSlots: integer("gme_slots"),
  pubmedCitationCount: integer("pubmed_citation_count").default(0),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityConstruction = pgTable("facility_construction", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  activePermits: jsonb("active_permits").default([]),
  bondIssuances: jsonb("bond_issuances").default([]),
  constructionNews: jsonb("construction_news").default([]),
  oshpdProjects: jsonb("oshpd_projects").default([]),
  projectEstCompletion: date("project_est_completion"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityCompetitive = pgTable("facility_competitive", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  primaryVendor: text("primary_vendor"),
  serviceContractType: text("service_contract_type"),
  serviceContractHolder: text("service_contract_holder"),
  eolEquipmentFlags: jsonb("eol_equipment_flags").default([]),
  lastPurchaseBrand: text("last_purchase_brand"),
  lastPurchaseYear: smallint("last_purchase_year"),
  lastPurchaseModality: text("last_purchase_modality"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityCompliance = pgTable("facility_compliance", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  cmsCitations: jsonb("cms_citations").default([]),
  stateSurveyFindings: jsonb("state_survey_findings").default([]),
  maudeReportsCount: integer("maude_reports_count").default(0),
  oshaCitations: jsonb("osha_citations").default([]),
  paymentSuspensionFlag: boolean("payment_suspension_flag").default(false),
  acrDoseRegistryMember: boolean("acr_dose_registry_member").default(false),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const facilityCommunity = pgTable("facility_community", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  facilityId: uuid("facility_id").notNull().unique().references(() => facilities.id, { onDelete: "cascade" }),
  serviceAreaPop: integer("service_area_pop"),
  serviceAreaMedianAge: numeric("service_area_median_age", { precision: 4, scale: 1 }),
  chronicDiseaseIndices: jsonb("chronic_disease_indices").default({}),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const radiationEquipmentRegistry = pgTable(
  "radiation_equipment_registry",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    facilityId: uuid("facility_id").references(() => facilities.id),
    state: char("state", { length: 2 }).notNull(),
    equipmentType: text("equipment_type").notNull(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    registrationNumber: text("registration_number"),
    registrationDate: date("registration_date"),
    lastInspectionDate: date("last_inspection_date"),
    registrationExpiry: date("registration_expiry"),
    source: text("source").default("state_radiation_control"),
    rawData: jsonb("raw_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("uniq_rad_reg").on(t.state, t.registrationNumber)],
);

export const contactValidationLog = pgTable(
  "contact_validation_log",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    contactId: uuid("contact_id").notNull().references(() => facilityContacts.id, { onDelete: "cascade" }),
    checkType: enrichmentSourceEnum("check_type").notNull(),
    result: text("result").notNull(),
    confidenceDelta: smallint("confidence_delta").default(0),
    rawResponse: jsonb("raw_response"),
    /** Cost of this single API call in millionths of a USD (micros).
     *  e.g. ZeroBounce ~$0.008/call → 8000 micros. Free sources record 0. */
    costMicros: bigint("cost_micros", { mode: "number" }).default(0),
    /** Number of HTTP attempts made (1 + retries). */
    attempts: smallint("attempts").default(1),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_val_log_contact").on(t.contactId, t.checkedAt)],
);

export const einCrosswalk = pgTable(
  "ein_crosswalk",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    ein: varchar("ein", { length: 9 }).notNull(),
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "cascade" }),
    entityName: text("entity_name").notNull(),
    entityCity: text("entity_city"),
    entityState: char("entity_state", { length: 2 }),
    nteeCode: varchar("ntee_code", { length: 10 }),
    matchType: text("match_type").notNull(), // "ein_exact", "system_name", "facility_name", "bmf_trgm"
    matchScore: numeric("match_score", { precision: 4, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_ein_crosswalk").on(t.ein, t.facilityId),
    index("idx_ein_crosswalk_ein").on(t.ein),
    index("idx_ein_crosswalk_facility").on(t.facilityId),
  ],
);
export type EinCrosswalk = typeof einCrosswalk.$inferSelect;

export const contactEnrichmentQueue = pgTable(
  "contact_enrichment_queue",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    contactId: uuid("contact_id").notNull().references(() => facilityContacts.id, { onDelete: "cascade" }),
    priority: smallint("priority").default(5),
    nextSource: enrichmentSourceEnum("next_source"),
    triggerReason: text("trigger_reason"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").default("queued"),
    errorMessage: text("error_message"),
  },
  (t) => [index("idx_enrich_queue_status").on(t.status, t.scheduledAt)],
);
