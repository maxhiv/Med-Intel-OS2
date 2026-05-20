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
  buyerRoleEnum,
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
    ein: varchar("ein", { length: 9 }),
    operatesHospital: boolean("operates_hospital").default(false),
    fiscalYearEndMonth: integer("fiscal_year_end_month"),
    fiscalYearEndSource: text("fiscal_year_end_source"),
    signalScore: smallint("signal_score").default(0),
    lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
    lastEnrichedAt: timestamp("last_enriched_at", { withTimezone: true }),
    scrapeErrors: integer("scrape_errors").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_facilities_state").on(t.state),
    index("idx_facilities_type").on(t.facilityType),
    index("idx_facilities_signal_score").on(t.signalScore),
    // Trigram GIN indexes power the CON ingestor's candidate-pool ILIKE
    // probes against name / DBA / system_name. Requires the `pg_trgm`
    // extension, which is created before schema push by
    // `lib/db/src/ensure-extensions.ts` (and re-asserted by `seed.ts`).
    index("idx_facilities_ein").on(t.ein),
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
    // ── v2.0 confidence + EOL extensions (handoff migration 007) ──────────
    confidenceScore: numeric("confidence_score", { precision: 3, scale: 2 }).default("0.00"),
    sourceCount: integer("source_count").default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).defaultNow(),
    contradicted: boolean("contradicted").default(false),
    stateRegistryId: text("state_registry_id"),
    fdaListingNumber: text("fda_listing_number"),
    manufacturerEolDate: date("manufacturer_eol_date"),
    manufacturerSupportEnded: boolean("manufacturer_support_ended").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_equip_facility").on(t.facilityId),
    index("idx_equip_modality").on(t.modality),
    index("idx_equip_urgency").on(t.urgencyTier),
    index("idx_equip_facility_modality").on(t.facilityId, t.modality),
    index("idx_equip_install_year").on(t.installYear),
    index("idx_equip_eol_date").on(t.manufacturerEolDate),
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
    metadata: jsonb("metadata"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").default(true),
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
    // ── v2.0 decision-maker graph extensions (handoff migration 011) ────
    buyerRole: buyerRoleEnum("buyer_role"),
    /** Which modalities this contact has authority over (CT, MRI, …). */
    modalityAuthority: text("modality_authority").array().default(sql`'{}'`),
    yearsInRole: smallint("years_in_role"),
    startedRoleAt: date("started_role_at"),
    /** verified | unverified | stale | bounced — see contact_verification_log */
    verificationStatus: text("verification_status").default("unverified"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_contacts_facility").on(t.facilityId),
    index("idx_contacts_confidence").on(t.confidenceScore),
    index("idx_contacts_buyer_role").on(t.facilityId, t.buyerRole),
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

export const irs990Raw = pgTable(
  "irs_990_raw",
  {
    // ── Identity & Filing ─────────────────────────────────────────────────
    ein: varchar("ein", { length: 9 }).primaryKey(),
    efile: text("efile"),
    taxPd: varchar("tax_pd", { length: 6 }),
    subseccd: smallint("subseccd"),
    nonpfrea: smallint("nonpfrea"),

    // ── Part IV — Checklist flags (Y/N text) ─────────────────────────────
    s501c3or4947a1cd: text("s501c3or4947a1cd"),
    schdbind: text("schdbind"),
    politicalactvtscd: text("politicalactvtscd"),
    lbbyingactvtscd: text("lbbyingactvtscd"),
    subjto6033cd: text("subjto6033cd"),
    dnradvisedfundscd: text("dnradvisedfundscd"),
    prptyintrcvdcd: text("prptyintrcvdcd"),
    maintwrkofartcd: text("maintwrkofartcd"),
    crcounselingqstncd: text("crcounselingqstncd"),
    hldassetsintermpermcd: text("hldassetsintermpermcd"),
    rptlndbldgeqptcd: text("rptlndbldgeqptcd"),
    rptinvstothsecd: text("rptinvstothsecd"),
    rptinvstprgrelcd: text("rptinvstprgrelcd"),
    rptothasstcd: text("rptothasstcd"),
    rptothliabcd: text("rptothliabcd"),
    sepcnsldtfinstmtcd: text("sepcnsldtfinstmtcd"),
    sepindaudfinstmtcd: text("sepindaudfinstmtcd"),
    inclinfinstmtcd: text("inclinfinstmtcd"),
    operateschools170cd: text("operateschools170cd"),
    frgnofficecd: text("frgnofficecd"),
    frgnrevexpnscd: text("frgnrevexpnscd"),
    frgngrntscd: text("frgngrntscd"),
    frgnaggragrntscd: text("frgnaggragrntscd"),
    rptprofndrsngfeescd: text("rptprofndrsngfeescd"),
    rptincfnndrsngcd: text("rptincfnndrsngcd"),
    rptincgamingcd: text("rptincgamingcd"),
    operatehosptlcd: text("operatehosptlcd"),
    hospaudfinstmtcd: text("hospaudfinstmtcd"),
    rptgrntstogovtcd: text("rptgrntstogovtcd"),
    rptgrntstoindvcd: text("rptgrntstoindvcd"),
    rptyestocompnstncd: text("rptyestocompnstncd"),
    txexmptbndcd: text("txexmptbndcd"),
    invstproceedscd: text("invstproceedscd"),
    maintescrwaccntcd: text("maintescrwaccntcd"),
    actonbehalfcd: text("actonbehalfcd"),
    engageexcessbnftcd: text("engageexcessbnftcd"),
    awarexcessbnftcd: text("awarexcessbnftcd"),
    loantofficercd: text("loantofficercd"),
    grantoofficercd: text("grantoofficercd"),
    dirbusnreltdcd: text("dirbusnreltdcd"),
    fmlybusnreltdcd: text("fmlybusnreltdcd"),
    servasofficercd: text("servasofficercd"),
    recvnoncashcd: text("recvnoncashcd"),
    recvartcd: text("recvartcd"),
    ceaseoperationscd: text("ceaseoperationscd"),
    sellorexchcd: text("sellorexchcd"),
    ownsepentcd: text("ownsepentcd"),
    reltdorgcd: text("reltdorgcd"),
    intincntrlcd: text("intincntrlcd"),
    orgtrnsfrcd: text("orgtrnsfrcd"),
    conduct5percentcd: text("conduct5percentcd"),
    compltschocd: text("compltschocd"),

    // ── Part V — Compliance counts & flags ───────────────────────────────
    f1096cnt: integer("f1096cnt"),
    fw2gcnt: integer("fw2gcnt"),
    wthldngrulescd: text("wthldngrulescd"),
    noemplyeesw3cnt: integer("noemplyeesw3cnt"),
    filerqrdrtnscd: text("filerqrdrtnscd"),
    unrelbusinccd: text("unrelbusinccd"),
    filedf990tcd: text("filedf990tcd"),
    frgnacctcd: text("frgnacctcd"),
    prohibtdtxshltrcd: text("prohibtdtxshltrcd"),
    prtynotifyorgcd: text("prtynotifyorgcd"),
    filedf8886tcd: text("filedf8886tcd"),
    solicitcntrbcd: text("solicitcntrbcd"),
    exprstmntcd: text("exprstmntcd"),
    providegoodscd: text("providegoodscd"),
    notfydnrvalcd: text("notfydnrvalcd"),
    filedf8282cd: text("filedf8282cd"),
    f8282cnt: integer("f8282cnt"),
    fndsrcvdcd: text("fndsrcvdcd"),
    premiumspaidcd: text("premiumspaidcd"),
    filedf8899cd: text("filedf8899cd"),
    filedf1098ccd: text("filedf1098ccd"),
    excbushldngscd: text("excbushldngscd"),
    s4966distribcd: text("s4966distribcd"),
    distribtodonorcd: text("distribtodonorcd"),

    // ── Part V — Amounts ──────────────────────────────────────────────────
    initiationfees: bigint("initiationfees", { mode: "number" }),
    grsrcptspublicuse: bigint("grsrcptspublicuse", { mode: "number" }),
    grsincmembers: bigint("grsincmembers", { mode: "number" }),
    grsincother: bigint("grsincother", { mode: "number" }),
    filedlieuf1041cd: text("filedlieuf1041cd"),
    txexmptint: bigint("txexmptint", { mode: "number" }),
    qualhlthplncd: text("qualhlthplncd"),
    qualhlthreqmntn: bigint("qualhlthreqmntn", { mode: "number" }),
    qualhlthonhnd: bigint("qualhlthonhnd", { mode: "number" }),
    rcvdpdtngcd: text("rcvdpdtngcd"),
    filedf720cd: text("filedf720cd"),

    // ── Part VII — Compensation ──────────────────────────────────────────
    totreprtabled: bigint("totreprtabled", { mode: "number" }),
    totcomprelatede: bigint("totcomprelatede", { mode: "number" }),
    totestcompf: bigint("totestcompf", { mode: "number" }),
    noindiv100kcnt: integer("noindiv100kcnt"),
    nocontractor100kcnt: integer("nocontractor100kcnt"),

    // ── Part VIII — Revenue ──────────────────────────────────────────────
    totcntrbgfts: bigint("totcntrbgfts", { mode: "number" }),
    prgmservcode2acd: text("prgmservcode2acd"),
    totrev2acola: bigint("totrev2acola", { mode: "number" }),
    prgmservcode2bcd: text("prgmservcode2bcd"),
    totrev2bcola: bigint("totrev2bcola", { mode: "number" }),
    prgmservcode2ccd: text("prgmservcode2ccd"),
    totrev2ccola: bigint("totrev2ccola", { mode: "number" }),
    prgmservcode2dcd: text("prgmservcode2dcd"),
    totrev2dcola: bigint("totrev2dcola", { mode: "number" }),
    prgmservcode2ecd: text("prgmservcode2ecd"),
    totrev2ecola: bigint("totrev2ecola", { mode: "number" }),
    totrev2fcola: bigint("totrev2fcola", { mode: "number" }),
    totprgmrevnue: bigint("totprgmrevnue", { mode: "number" }),
    invstmntinc: bigint("invstmntinc", { mode: "number" }),
    txexmptbndsproceeds: bigint("txexmptbndsproceeds", { mode: "number" }),
    royaltsinc: bigint("royaltsinc", { mode: "number" }),
    grsrntsreal: bigint("grsrntsreal", { mode: "number" }),
    grsrntsprsnl: bigint("grsrntsprsnl", { mode: "number" }),
    rntlexpnsreal: bigint("rntlexpnsreal", { mode: "number" }),
    rntlexpnsprsnl: bigint("rntlexpnsprsnl", { mode: "number" }),
    rntlincreal: bigint("rntlincreal", { mode: "number" }),
    rntlincprsnl: bigint("rntlincprsnl", { mode: "number" }),
    netrntlinc: bigint("netrntlinc", { mode: "number" }),
    grsalesecur: bigint("grsalesecur", { mode: "number" }),
    grsalesothr: bigint("grsalesothr", { mode: "number" }),
    cstbasisecur: bigint("cstbasisecur", { mode: "number" }),
    cstbasisothr: bigint("cstbasisothr", { mode: "number" }),
    gnlsecur: bigint("gnlsecur", { mode: "number" }),
    gnlsothr: bigint("gnlsothr", { mode: "number" }),
    netgnls: bigint("netgnls", { mode: "number" }),
    grsincfndrsng: bigint("grsincfndrsng", { mode: "number" }),
    lessdirfndrsng: bigint("lessdirfndrsng", { mode: "number" }),
    netincfndrsng: bigint("netincfndrsng", { mode: "number" }),
    grsincgaming: bigint("grsincgaming", { mode: "number" }),
    lessdirgaming: bigint("lessdirgaming", { mode: "number" }),
    netincgaming: bigint("netincgaming", { mode: "number" }),
    grsalesinvent: bigint("grsalesinvent", { mode: "number" }),
    lesscstofgoods: bigint("lesscstofgoods", { mode: "number" }),
    netincsales: bigint("netincsales", { mode: "number" }),
    miscrev11acd: text("miscrev11acd"),
    miscrevtota: bigint("miscrevtota", { mode: "number" }),
    miscrev11bcd: text("miscrev11bcd"),
    miscrevtot11b: bigint("miscrevtot11b", { mode: "number" }),
    miscrev11ccd: text("miscrev11ccd"),
    miscrevtot11c: bigint("miscrevtot11c", { mode: "number" }),
    miscrevtot11d: bigint("miscrevtot11d", { mode: "number" }),
    miscrevtot11e: bigint("miscrevtot11e", { mode: "number" }),
    totrevenue: bigint("totrevenue", { mode: "number" }),

    // ── Part IX — Expenses ───────────────────────────────────────────────
    grntstogovt: bigint("grntstogovt", { mode: "number" }),
    grnsttoindiv: bigint("grnsttoindiv", { mode: "number" }),
    grntstofrgngovt: bigint("grntstofrgngovt", { mode: "number" }),
    benifitsmembrs: bigint("benifitsmembrs", { mode: "number" }),
    compnsatncurrofcr: bigint("compnsatncurrofcr", { mode: "number" }),
    compnsatnandothr: bigint("compnsatnandothr", { mode: "number" }),
    othrsalwages: bigint("othrsalwages", { mode: "number" }),
    pensionplancontrb: bigint("pensionplancontrb", { mode: "number" }),
    othremplyeebenef: bigint("othremplyeebenef", { mode: "number" }),
    payrolltx: bigint("payrolltx", { mode: "number" }),
    feesforsrvcmgmt: bigint("feesforsrvcmgmt", { mode: "number" }),
    legalfees: bigint("legalfees", { mode: "number" }),
    accntingfees: bigint("accntingfees", { mode: "number" }),
    feesforsrvclobby: bigint("feesforsrvclobby", { mode: "number" }),
    profndraising: bigint("profndraising", { mode: "number" }),
    feesforsrvcinvstmgmt: bigint("feesforsrvcinvstmgmt", { mode: "number" }),
    feesforsrvcothr: bigint("feesforsrvcothr", { mode: "number" }),
    advrtpromo: bigint("advrtpromo", { mode: "number" }),
    officexpns: bigint("officexpns", { mode: "number" }),
    infotech: bigint("infotech", { mode: "number" }),
    royaltsexpns: bigint("royaltsexpns", { mode: "number" }),
    occupancy: bigint("occupancy", { mode: "number" }),
    travel: bigint("travel", { mode: "number" }),
    travelofpublicoffcl: bigint("travelofpublicoffcl", { mode: "number" }),
    converconventmtng: bigint("converconventmtng", { mode: "number" }),
    interestamt: bigint("interestamt", { mode: "number" }),
    pymtoaffiliates: bigint("pymtoaffiliates", { mode: "number" }),
    deprcatndepletn: bigint("deprcatndepletn", { mode: "number" }),
    insurance: bigint("insurance", { mode: "number" }),
    othrexpnsa: bigint("othrexpnsa", { mode: "number" }),
    othrexpnsb: bigint("othrexpnsb", { mode: "number" }),
    othrexpnsc: bigint("othrexpnsc", { mode: "number" }),
    othrexpnsd: bigint("othrexpnsd", { mode: "number" }),
    othrexpnse: bigint("othrexpnse", { mode: "number" }),
    othrexpnsf: bigint("othrexpnsf", { mode: "number" }),
    totfuncexpns: bigint("totfuncexpns", { mode: "number" }),

    // ── Part X — Balance Sheet ───────────────────────────────────────────
    nonintcashend: bigint("nonintcashend", { mode: "number" }),
    svngstempinvend: bigint("svngstempinvend", { mode: "number" }),
    pldgegrntrcvblend: bigint("pldgegrntrcvblend", { mode: "number" }),
    accntsrcvblend: bigint("accntsrcvblend", { mode: "number" }),
    currfrmrcvblend: bigint("currfrmrcvblend", { mode: "number" }),
    rcvbldisqualend: bigint("rcvbldisqualend", { mode: "number" }),
    notesloansrcvblend: bigint("notesloansrcvblend", { mode: "number" }),
    invntriesalesend: bigint("invntriesalesend", { mode: "number" }),
    prepaidexpnsend: bigint("prepaidexpnsend", { mode: "number" }),
    lndbldgsequipend: bigint("lndbldgsequipend", { mode: "number" }),
    invstmntsend: bigint("invstmntsend", { mode: "number" }),
    invstmntsothrend: bigint("invstmntsothrend", { mode: "number" }),
    invstmntsprgmend: bigint("invstmntsprgmend", { mode: "number" }),
    intangibleassetsend: bigint("intangibleassetsend", { mode: "number" }),
    othrassetsend: bigint("othrassetsend", { mode: "number" }),
    totassetsend: bigint("totassetsend", { mode: "number" }),
    accntspayableend: bigint("accntspayableend", { mode: "number" }),
    grntspayableend: bigint("grntspayableend", { mode: "number" }),
    deferedrevnuend: bigint("deferedrevnuend", { mode: "number" }),
    txexmptbndsend: bigint("txexmptbndsend", { mode: "number" }),
    escrwaccntliabend: bigint("escrwaccntliabend", { mode: "number" }),
    paybletoffcrsend: bigint("paybletoffcrsend", { mode: "number" }),
    secrdmrtgsend: bigint("secrdmrtgsend", { mode: "number" }),
    unsecurednotesend: bigint("unsecurednotesend", { mode: "number" }),
    othrliabend: bigint("othrliabend", { mode: "number" }),
    totliabend: bigint("totliabend", { mode: "number" }),
    unrstrctnetasstsend: bigint("unrstrctnetasstsend", { mode: "number" }),
    temprstrctnetasstsend: bigint("temprstrctnetasstsend", { mode: "number" }),
    permrstrctnetasstsend: bigint("permrstrctnetasstsend", { mode: "number" }),
    capitalstktrstend: bigint("capitalstktrstend", { mode: "number" }),
    paidinsurplusend: bigint("paidinsurplusend", { mode: "number" }),
    retainedearnend: bigint("retainedearnend", { mode: "number" }),
    totnetassetend: bigint("totnetassetend", { mode: "number" }),
    totnetliabastend: bigint("totnetliabastend", { mode: "number" }),

    // ── Schedule A — Public Support ──────────────────────────────────────
    totnooforgscnt: integer("totnooforgscnt"),
    totsupport: bigint("totsupport", { mode: "number" }),
    gftgrntsrcvd170: bigint("gftgrntsrcvd170", { mode: "number" }),
    txrevnuelevied170: bigint("txrevnuelevied170", { mode: "number" }),
    srvcsval170: bigint("srvcsval170", { mode: "number" }),
    pubsuppsubtot170: bigint("pubsuppsubtot170", { mode: "number" }),
    exceeds2pct170: bigint("exceeds2pct170", { mode: "number" }),
    pubsupplesspct170: bigint("pubsupplesspct170", { mode: "number" }),
    samepubsuppsubtot170: bigint("samepubsuppsubtot170", { mode: "number" }),
    grsinc170: bigint("grsinc170", { mode: "number" }),
    netincunreltd170: bigint("netincunreltd170", { mode: "number" }),
    othrinc170: bigint("othrinc170", { mode: "number" }),
    totsupp170: bigint("totsupp170", { mode: "number" }),
    grsrcptsrelated170: bigint("grsrcptsrelated170", { mode: "number" }),
    totgftgrntrcvd509: bigint("totgftgrntrcvd509", { mode: "number" }),
    grsrcptsadmissn509: bigint("grsrcptsadmissn509", { mode: "number" }),
    grsrcptsactivities509: bigint("grsrcptsactivities509", { mode: "number" }),
    txrevnuelevied509: bigint("txrevnuelevied509", { mode: "number" }),
    srvcsval509: bigint("srvcsval509", { mode: "number" }),
    pubsuppsubtot509: bigint("pubsuppsubtot509", { mode: "number" }),
    rcvdfrmdisqualsub509: bigint("rcvdfrmdisqualsub509", { mode: "number" }),
    exceeds1pct509: bigint("exceeds1pct509", { mode: "number" }),
    subtotpub509: bigint("subtotpub509", { mode: "number" }),
    pubsupplesub509: bigint("pubsupplesub509", { mode: "number" }),
    samepubsuppsubtot509: bigint("samepubsuppsubtot509", { mode: "number" }),
    grsinc509: bigint("grsinc509", { mode: "number" }),
    unreltxincls511tx509: bigint("unreltxincls511tx509", { mode: "number" }),
    subtotsuppinc509: bigint("subtotsuppinc509", { mode: "number" }),
    netincunrelatd509: bigint("netincunrelatd509", { mode: "number" }),
    othrinc509: bigint("othrinc509", { mode: "number" }),
    totsupp509: bigint("totsupp509", { mode: "number" }),

    // ── Matching columns ─────────────────────────────────────────────────
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "set null" }),
    matchScore: numeric("match_score", { precision: 4, scale: 3 }),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    // Org name from IRS EO BMF — populated by Task #104 import, NULL in 990 extract
    orgName: text("org_name"),

    // ── Audit ─────────────────────────────────────────────────────────────
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_990_raw_hosptl").on(t.operatehosptlcd),
    index("idx_990_raw_taxpd").on(t.taxPd),
    index("idx_990_raw_revenue").on(t.totrevenue),
    index("idx_990_raw_facility").on(t.facilityId),
  ],
);

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
