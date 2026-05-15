import { pgEnum } from "drizzle-orm/pg-core";

export const ownershipTypeEnum = pgEnum("ownership_type", [
  "nonprofit",
  "for_profit",
  "government",
  "unknown",
]);

export const crmTypeEnum = pgEnum("crm_type", [
  "ghl",
  "hubspot",
  "salesforce",
  "pipedrive",
  "zoho",
  "close",
  "dynamics",
  "other",
]);

export const signalTypeEnum = pgEnum("signal_type", [
  "depreciation_flag",
  "con_filed",
  "con_approved",
  "grant_awarded",
  "bond_issuance",
  "bond_issued",
  "rfp_posted",
  "hcris_depreciation_spike",
  "high_utilization",
  "equipment_age_7yr",
  "adverse_event_spike",
  "sec_capex_flag",
  "construction_permit",
  "leadership_change",
  "service_line_expansion",
  "job_posting",
  "news_expansion",
  "eol_equipment",
  "accreditation_renewal",
  "compliance_citation",
  "nih_grant",
  "clinical_trial",
  "fiscal_year_end",
  "system_signal_propagated",
  "financial_health",
  "capital_investment",
  "workforce_expansion",
  "hospital_operator",
]);

export const contactStatusEnum = pgEnum("contact_status", [
  "unverified",
  "verified",
  "bounced",
  "unsubscribed",
  "do_not_contact",
]);

export const outreachChannelEnum = pgEnum("outreach_channel", [
  "email",
  "linkedin",
  "phone",
  "both",
]);

export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "active",
  "paused",
  "replied",
  "complete",
  "unsubscribed",
  "bounced",
]);

export const draftStatusEnum = pgEnum("draft_status", [
  "pending",
  "approved",
  "sent",
  "skipped",
  "rejected",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "pending",
  "running",
  "complete",
  "failed",
  "partial",
]);

export const reportStatusEnum = pgEnum("report_status", [
  "queued",
  "running",
  "complete",
  "failed",
]);

export const planTierEnum = pgEnum("plan_tier", [
  "starter",
  "growth",
  "enterprise",
  "internal",
]);

export const enrichmentSourceEnum = pgEnum("enrichment_source", [
  "npi_registry",
  "doximity",
  "website_scrape",
  "cms_billing",
  "professional_directory",
  "clinicaltrials",
  "nih_reporter",
  "propublica_990",
  "hcris",
  "con_filing",
  "radiation_registry",
  "apollo",
  "netrows",
  "zerobounce",
  "bouncer",
  "twilio",
  "people_data_labs",
  "zoominfo",
  "definitive_hc",
  "openpermit",
]);

export const FREE_ENRICHMENT_SOURCES = [
  "npi_registry",
  "doximity",
  "website_scrape",
  "cms_billing",
  "professional_directory",
  "clinicaltrials",
  "nih_reporter",
  "propublica_990",
  "hcris",
  "con_filing",
  "radiation_registry",
] as const;

export const PAID_ENRICHMENT_SOURCES = [
  "apollo",
  "netrows",
  "zerobounce",
  "bouncer",
  "twilio",
  "people_data_labs",
  "zoominfo",
  "definitive_hc",
  "openpermit",
] as const;
