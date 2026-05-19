/**
 * Read-only Drizzle bindings for the `medintel` warehouse schema (loaded by
 * `medintel_os/medintel_os_schema.sql` + `medintel_os_load.sql`).
 *
 * These declarations only cover columns the API actually reads; the warehouse
 * has more fields on disk. We intentionally do NOT add `createInsertSchema` /
 * insert types here — writes belong to the SQL load script, not the app.
 *
 * The schema lives in its own Postgres schema (`medintel.*`) so it sits
 * alongside the app's tables (`public.*`) without naming collisions. Drizzle
 * `pgSchema("medintel")` emits schema-qualified SQL, so search_path does not
 * have to be tweaked at the connection level.
 */
import {
  pgSchema,
  text,
  varchar,
  bigint,
  integer,
  smallint,
  numeric,
  boolean,
  date,
  char,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const medintelSchema = pgSchema("medintel");

// ── dim_facility ─────────────────────────────────────────────────────────────
export const medintelDimFacility = medintelSchema.table("dim_facility", {
  enrollmentId: text("enrollment_id").primaryKey(),
  enrollmentState: char("enrollment_state", { length: 2 }),
  providerTypeCode: text("provider_type_code"),
  providerTypeText: text("provider_type_text"),
  vertical: text("vertical"),
  primaryNpi: bigint("primary_npi", { mode: "number" }),
  multipleNpiFlag: boolean("multiple_npi_flag"),
  ccn: text("ccn"),
  ccnAcronym: varchar("ccn_acronym", { length: 8 }),
  associateId: bigint("associate_id", { mode: "number" }),
  organizationName: text("organization_name"),
  doingBusinessAsName: text("doing_business_as_name"),
  incorporationDate: date("incorporation_date"),
  incorporationState: char("incorporation_state", { length: 2 }),
  organizationTypeStructure: text("organization_type_structure"),
  organizationOtherTypeText: text("organization_other_type_text"),
  proprietaryNonprofit: char("proprietary_nonprofit", { length: 1 }),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: char("state", { length: 2 }),
  zipCode: varchar("zip_code", { length: 10 }),
  telephoneNumber: text("telephone_number"),
  sourceFile: text("source_file"),
  sourceAsOfDate: date("source_as_of_date"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
});

// ── dim_owner ────────────────────────────────────────────────────────────────
export const medintelDimOwner = medintelSchema.table("dim_owner", {
  associateIdOwner: bigint("associate_id_owner", { mode: "number" }).primaryKey(),
  ownerType: text("owner_type"),
  firstName: text("first_name"),
  middleName: text("middle_name"),
  lastName: text("last_name"),
  title: text("title"),
  organizationName: text("organization_name"),
  doingBusinessAsName: text("doing_business_as_name"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: char("state", { length: 2 }),
  zipCode: varchar("zip_code", { length: 10 }),
  isCorporation: boolean("is_corporation"),
  isLlc: boolean("is_llc"),
  isMedicalProvider: boolean("is_medical_provider"),
  isMgmtServices: boolean("is_mgmt_services"),
  isMedicalStaffing: boolean("is_medical_staffing"),
  isHoldingCompany: boolean("is_holding_company"),
  isInvestmentFirm: boolean("is_investment_firm"),
  isFinancialInst: boolean("is_financial_inst"),
  isConsultingFirm: boolean("is_consulting_firm"),
  isForProfit: boolean("is_for_profit"),
  isNonProfit: boolean("is_non_profit"),
  isPrivateEquity: boolean("is_private_equity"),
  isReit: boolean("is_reit"),
  isChainHomeOffice: boolean("is_chain_home_office"),
  otherTypeText: text("other_type_text"),
  ownedByAnother: boolean("owned_by_another"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
});

// ── fact_ownership ───────────────────────────────────────────────────────────
export const medintelFactOwnership = medintelSchema.table("fact_ownership", {
  enrollmentId: text("enrollment_id").notNull(),
  associateIdOwner: bigint("associate_id_owner", { mode: "number" }).notNull(),
  roleCode: integer("role_code").notNull(),
  roleText: text("role_text"),
  ownerType: char("owner_type", { length: 1 }),
  associationDate: date("association_date"),
  percentageOwnership: numeric("percentage_ownership", { precision: 6, scale: 2 }),
  createdForAcquisition: boolean("created_for_acquisition"),
  isCorporation: boolean("is_corporation"),
  isLlc: boolean("is_llc"),
  isHoldingCompany: boolean("is_holding_company"),
  isPrivateEquity: boolean("is_private_equity"),
  isReit: boolean("is_reit"),
  isChainHomeOffice: boolean("is_chain_home_office"),
  isMgmtServices: boolean("is_mgmt_services"),
  isForProfit: boolean("is_for_profit"),
  isNonProfit: boolean("is_non_profit"),
  sourceFile: text("source_file"),
  sourceAsOfDate: date("source_as_of_date"),
});

// ── fact_chow ────────────────────────────────────────────────────────────────
export const medintelFactChow = medintelSchema.table("fact_chow", {
  chowPk: bigint("chow_pk", { mode: "number" }).primaryKey(),
  enrollmentIdBuyer: text("enrollment_id_buyer"),
  enrollmentStateBuyer: char("enrollment_state_buyer", { length: 2 }),
  providerTypeCodeBuyer: text("provider_type_code_buyer"),
  providerTypeTextBuyer: text("provider_type_text_buyer"),
  npiBuyer: bigint("npi_buyer", { mode: "number" }),
  ccnBuyer: text("ccn_buyer"),
  associateIdBuyer: bigint("associate_id_buyer", { mode: "number" }),
  organizationNameBuyer: text("organization_name_buyer"),
  dbaNameBuyer: text("dba_name_buyer"),
  chowTypeCode: text("chow_type_code"),
  chowTypeText: text("chow_type_text"),
  effectiveDate: date("effective_date"),
  enrollmentIdSeller: text("enrollment_id_seller"),
  enrollmentStateSeller: char("enrollment_state_seller", { length: 2 }),
  providerTypeCodeSeller: text("provider_type_code_seller"),
  providerTypeTextSeller: text("provider_type_text_seller"),
  npiSeller: bigint("npi_seller", { mode: "number" }),
  ccnSeller: text("ccn_seller"),
  associateIdSeller: bigint("associate_id_seller", { mode: "number" }),
  organizationNameSeller: text("organization_name_seller"),
  dbaNameSeller: text("dba_name_seller"),
  vertical: text("vertical"),
  sourceFile: text("source_file"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
});

// ── fact_cost_report ─────────────────────────────────────────────────────────
// Only the columns we surface on the hospital card or feed into scoring.
export const medintelFactCostReport = medintelSchema.table("fact_cost_report", {
  rptRecNum: bigint("rpt_rec_num", { mode: "number" }).primaryKey(),
  providerCcn: text("provider_ccn"),
  hospitalName: text("hospital_name"),
  stateCode: char("state_code", { length: 2 }),
  fiscalYearBeginDate: date("fiscal_year_begin_date"),
  fiscalYearEndDate: date("fiscal_year_end_date"),
  numberOfBeds: numeric("number_of_beds"),
  totalDaysAll: numeric("total_days_all"),
  totalDischargesAll: numeric("total_discharges_all"),
  totalSalariesWsa: numeric("total_salaries_wsa"),
  depreciationCost: numeric("depreciation_cost"),
  totalCosts: numeric("total_costs"),
  inpatientTotalCharges: numeric("inpatient_total_charges"),
  outpatientTotalCharges: numeric("outpatient_total_charges"),
  combinedIoTotalCharges: numeric("combined_io_total_charges"),
  costOfCharityCare: numeric("cost_of_charity_care"),
  totalBadDebtExpense: numeric("total_bad_debt_expense"),
  costOfUncompensatedCare: numeric("cost_of_uncompensated_care"),
  cashOnHandInBanks: numeric("cash_on_hand_in_banks"),
  totalCurrentAssets: numeric("total_current_assets"),
  totalAssets: numeric("total_assets"),
  investments: numeric("investments"),
  totalLiabilities: numeric("total_liabilities"),
  inpatientRevenue: numeric("inpatient_revenue"),
  outpatientRevenue: numeric("outpatient_revenue"),
  totalPatientRevenue: numeric("total_patient_revenue"),
  netPatientRevenue: numeric("net_patient_revenue"),
  totalIncome: numeric("total_income"),
  netIncome: numeric("net_income"),
  costToChargeRatio: numeric("cost_to_charge_ratio"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
});

// ── fact_service_area ────────────────────────────────────────────────────────
export const medintelFactServiceArea = medintelSchema.table("fact_service_area", {
  ccn: text("ccn").notNull(),
  zipCode: varchar("zip_code", { length: 5 }).notNull(),
  calendarYear: smallint("calendar_year").notNull(),
  totalDischarges: numeric("total_discharges"),
  totalDays: numeric("total_days"),
  totalCharges: numeric("total_charges"),
});

// ── fact_psi11 ───────────────────────────────────────────────────────────────
export const medintelFactPsi11 = medintelSchema.table("fact_psi11", {
  hospId: integer("hosp_id").notNull(),
  admDisc: numeric("adm_disc"),
  rate: numeric("rate"),
  intervalLowerLimit: numeric("interval_lower_limit"),
  intervalHigherLimit: numeric("interval_higher_limit"),
  startQuarter: text("start_quarter").notNull(),
  startDate: date("start_date"),
  endQuarter: text("end_quarter"),
  endDate: date("end_date"),
});

// ── dim_aco ──────────────────────────────────────────────────────────────────
export const medintelDimAco = medintelSchema.table("dim_aco", {
  acoId: text("aco_id").primaryKey(),
  acoName: text("aco_name"),
  agreeType: text("agree_type"),
  agreementPeriodNum: integer("agreement_period_num"),
  currentStartDate: date("current_start_date"),
  currentTrack: text("current_track"),
  riskModel: text("risk_model"),
  assignType: text("assign_type"),
  snfWaiver: boolean("snf_waiver"),
});

// ── fact_aco_performance ─────────────────────────────────────────────────────
export const medintelFactAcoPerformance = medintelSchema.table("fact_aco_performance", {
  acoId: text("aco_id").notNull(),
  performanceYear: smallint("performance_year").notNull(),
  nAb: integer("n_ab"),
  savRate: numeric("sav_rate"),
  qualScore: numeric("qual_score"),
  aipFlag: boolean("aip_flag"),
  aipBalance: text("aip_balance"),
  earnSaveLoss: integer("earn_save_loss"),
  finalShareRate: numeric("final_share_rate"),
  nCah: integer("n_cah"),
  nFqhc: integer("n_fqhc"),
  nRhc: integer("n_rhc"),
  nHosp: integer("n_hosp"),
  additionalFields: jsonb("additional_fields"),
});

// ── fact_aip_spending ────────────────────────────────────────────────────────
export const medintelFactAipSpending = medintelSchema.table("fact_aip_spending", {
  aipPk: bigint("aip_pk", { mode: "number" }).primaryKey(),
  acoId: text("aco_id").notNull(),
  paymentUse: text("payment_use"),
  generalSpendCategory: text("general_spend_category"),
  generalSpendSubcategory: text("general_spend_subcategory"),
  totalAipReceivedThruDec2025: text("total_aip_received_thru_dec_2025"),
  projectedSpending2024: numeric("projected_spending_2024"),
  actualSpending2024: numeric("actual_spending_2024"),
  projectedSpending2025: numeric("projected_spending_2025"),
  actualSpending2025: numeric("actual_spending_2025"),
  projectedSpending2026: numeric("projected_spending_2026"),
  actualSpending2026: numeric("actual_spending_2026"),
});

// ── fact_asm_participant ─────────────────────────────────────────────────────
export const medintelFactAsmParticipant = medintelSchema.table("fact_asm_participant", {
  npi: bigint("npi", { mode: "number" }).notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  state: char("state", { length: 2 }),
  asmCohort: text("asm_cohort").notNull(),
  organizationLegalName: text("organization_legal_name"),
  asmCy27Participant: boolean("asm_cy27_participant"),
  asmCy28Participant: boolean("asm_cy28_participant"),
  asmCy29Participant: boolean("asm_cy29_participant"),
});

// ── dim_cmmi_model ───────────────────────────────────────────────────────────
export const medintelDimCmmiModel = medintelSchema.table("dim_cmmi_model", {
  uniqueId: integer("unique_id").primaryKey(),
  modelName: text("model_name"),
  stage: text("stage"),
  numberOfParticipants: text("number_of_participants"),
  category: text("category"),
  authority: text("authority"),
  description: text("description"),
  dateBegan: integer("date_began"),
  dateEnded: integer("date_ended"),
  states: text("states").array(),
  keywords: text("keywords").array(),
  url: text("url"),
  displayModelSummary: boolean("display_model_summary"),
});

// ── bridge_npi_enrollment ────────────────────────────────────────────────────
export const medintelBridgeNpiEnrollment = medintelSchema.table("bridge_npi_enrollment", {
  enrollmentId: text("enrollment_id").notNull(),
  npi: bigint("npi", { mode: "number" }).notNull(),
  isPrimary: boolean("is_primary").notNull(),
  sourceFile: text("source_file"),
});

// ── bridge_facility_address ──────────────────────────────────────────────────
export const medintelBridgeFacilityAddress = medintelSchema.table(
  "bridge_facility_address",
  {
    addressPk: bigint("address_pk", { mode: "number" }).primaryKey(),
    enrollmentId: text("enrollment_id").notNull(),
    isPrimary: boolean("is_primary").notNull(),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: char("state", { length: 2 }),
    zipCode: varchar("zip_code", { length: 10 }),
    telephoneNumber: text("telephone_number"),
    sourceFile: text("source_file"),
  },
);

// Type exports — used by the API repo to shape its return values.
export type MedintelDimFacility = typeof medintelDimFacility.$inferSelect;
export type MedintelDimOwner = typeof medintelDimOwner.$inferSelect;
export type MedintelFactOwnership = typeof medintelFactOwnership.$inferSelect;
export type MedintelFactChow = typeof medintelFactChow.$inferSelect;
export type MedintelFactCostReport = typeof medintelFactCostReport.$inferSelect;
export type MedintelFactServiceArea = typeof medintelFactServiceArea.$inferSelect;
export type MedintelFactPsi11 = typeof medintelFactPsi11.$inferSelect;
export type MedintelDimAco = typeof medintelDimAco.$inferSelect;
export type MedintelFactAcoPerformance = typeof medintelFactAcoPerformance.$inferSelect;
export type MedintelFactAipSpending = typeof medintelFactAipSpending.$inferSelect;
export type MedintelFactAsmParticipant = typeof medintelFactAsmParticipant.$inferSelect;
export type MedintelDimCmmiModel = typeof medintelDimCmmiModel.$inferSelect;
export type MedintelBridgeNpiEnrollment = typeof medintelBridgeNpiEnrollment.$inferSelect;
export type MedintelBridgeFacilityAddress = typeof medintelBridgeFacilityAddress.$inferSelect;
