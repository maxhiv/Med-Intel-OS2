CREATE TYPE "public"."contact_status" AS ENUM('unverified', 'verified', 'bounced', 'unsubscribed', 'do_not_contact');--> statement-breakpoint
CREATE TYPE "public"."crm_type" AS ENUM('ghl', 'hubspot', 'salesforce', 'pipedrive', 'zoho', 'close', 'dynamics', 'other');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('pending', 'approved', 'sent', 'skipped', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."enrichment_source" AS ENUM('npi_registry', 'doximity', 'website_scrape', 'cms_billing', 'professional_directory', 'clinicaltrials', 'nih_reporter', 'propublica_990', 'hcris', 'con_filing', 'radiation_registry', 'apollo', 'netrows', 'zerobounce', 'bouncer', 'twilio', 'people_data_labs', 'zoominfo', 'definitive_hc', 'openpermit');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('active', 'paused', 'replied', 'complete', 'unsubscribed', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."outreach_channel" AS ENUM('email', 'linkedin', 'phone', 'both');--> statement-breakpoint
CREATE TYPE "public"."ownership_type" AS ENUM('nonprofit', 'for_profit', 'government', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('starter', 'growth', 'enterprise', 'internal');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('queued', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('depreciation_flag', 'con_filed', 'con_approved', 'grant_awarded', 'bond_issuance', 'bond_issued', 'rfp_posted', 'hcris_depreciation_spike', 'high_utilization', 'equipment_age_7yr', 'adverse_event_spike', 'sec_capex_flag', 'construction_permit', 'leadership_change', 'service_line_expansion', 'job_posting', 'news_expansion', 'eol_equipment', 'accreditation_renewal', 'compliance_citation', 'nih_grant', 'clinical_trial', 'fiscal_year_end');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('pending', 'running', 'complete', 'failed', 'partial');--> statement-breakpoint
CREATE TABLE "con_filings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid,
	"state" char(2) NOT NULL,
	"filing_date" date,
	"decision_date" date,
	"equipment_type" text,
	"modality" text,
	"requested_amount" bigint,
	"approved_amount" bigint,
	"status" text,
	"applicant_name" text,
	"filing_url" text,
	"notes" text,
	"match_score" numeric(4, 3),
	"match_field" text,
	"review_status" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contact_enrichment_queue" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"contact_id" uuid NOT NULL,
	"priority" smallint DEFAULT 5,
	"next_source" "enrichment_source",
	"trigger_reason" text,
	"scheduled_at" timestamp with time zone DEFAULT now(),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'queued',
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "contact_validation_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"contact_id" uuid NOT NULL,
	"check_type" "enrichment_source" NOT NULL,
	"result" text NOT NULL,
	"confidence_delta" smallint DEFAULT 0,
	"raw_response" jsonb,
	"cost_micros" bigint DEFAULT 0,
	"attempts" smallint DEFAULT 1,
	"checked_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "equipment_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"modality" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"install_year" smallint,
	"original_cost" bigint,
	"book_value" bigint,
	"accum_depreciation" bigint,
	"pct_depreciated" numeric(5, 2),
	"est_replacement_year" smallint,
	"urgency_tier" text DEFAULT 'unknown',
	"registration_number" text,
	"registration_date" date,
	"last_inspection_date" date,
	"registration_expiry" date,
	"source_doc_id" uuid,
	"source_type" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"npi" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"doing_business_as" text,
	"facility_type" text NOT NULL,
	"cms_id" text,
	"beds" integer,
	"ownership" "ownership_type" DEFAULT 'unknown',
	"system_name" text,
	"idn_id" uuid,
	"address1" text,
	"city" text,
	"state" char(2),
	"zip" varchar(10),
	"county" text,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"website" text,
	"cah_designation" boolean DEFAULT false,
	"dsh_pct" numeric(5, 2),
	"scp_designation" boolean DEFAULT false,
	"fqhc_designation" boolean DEFAULT false,
	"teaching_hospital" boolean DEFAULT false,
	"gme_slots" integer,
	"signal_score" smallint DEFAULT 0,
	"last_scraped_at" timestamp with time zone,
	"last_enriched_at" timestamp with time zone,
	"scrape_errors" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facilities_npi_unique" UNIQUE("npi"),
	CONSTRAINT "signal_score_range" CHECK ("facilities"."signal_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "facility_accreditation" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"jc_accredited" boolean DEFAULT false,
	"jc_last_survey_date" date,
	"jc_next_survey_est" date,
	"acr_last_accred_date" date,
	"acr_renewal_est" date,
	"leapfrog_grade" char(1),
	"cms_star_rating" smallint,
	"magnet_designation" boolean DEFAULT false,
	"mqsa_cert_date" date,
	"nrc_license_number" text,
	"nrc_license_expiry" date,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_accreditation_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_clinical_volume" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"cms_year" smallint NOT NULL,
	"annual_ct_volume" integer,
	"annual_mri_volume" integer,
	"annual_pet_volume" integer,
	"annual_xray_volume" integer,
	"annual_nuclear_med_volume" integer,
	"case_mix_index" numeric(5, 2),
	"trauma_level" smallint,
	"inpatient_discharges" integer,
	"outpatient_visits" integer
);
--> statement-breakpoint
CREATE TABLE "facility_community" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"service_area_pop" integer,
	"service_area_median_age" numeric(4, 1),
	"chronic_disease_indices" jsonb DEFAULT '{}'::jsonb,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_community_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_competitive" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"primary_vendor" text,
	"service_contract_type" text,
	"service_contract_holder" text,
	"eol_equipment_flags" jsonb DEFAULT '[]'::jsonb,
	"last_purchase_brand" text,
	"last_purchase_year" smallint,
	"last_purchase_modality" text,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_competitive_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_compliance" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"cms_citations" jsonb DEFAULT '[]'::jsonb,
	"state_survey_findings" jsonb DEFAULT '[]'::jsonb,
	"maude_reports_count" integer DEFAULT 0,
	"osha_citations" jsonb DEFAULT '[]'::jsonb,
	"payment_suspension_flag" boolean DEFAULT false,
	"acr_dose_registry_member" boolean DEFAULT false,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_compliance_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_construction" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"active_permits" jsonb DEFAULT '[]'::jsonb,
	"bond_issuances" jsonb DEFAULT '[]'::jsonb,
	"construction_news" jsonb DEFAULT '[]'::jsonb,
	"oshpd_projects" jsonb DEFAULT '[]'::jsonb,
	"project_est_completion" date,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_construction_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"title" text,
	"department" text,
	"npi" varchar(10),
	"email" text,
	"email_status" "contact_status" DEFAULT 'unverified',
	"email_confidence" smallint DEFAULT 0,
	"phone" text,
	"phone_type" text,
	"phone_valid" boolean,
	"linkedin_url" text,
	"linkedin_data" jsonb,
	"linkedin_last_activity" timestamp with time zone,
	"confidence_score" smallint DEFAULT 0,
	"doximity_verified" boolean DEFAULT false,
	"cms_billing_verified" boolean DEFAULT false,
	"human_verified" boolean DEFAULT false,
	"human_verified_at" timestamp with time zone,
	"human_verified_by" uuid,
	"buying_authority_score" smallint DEFAULT 0,
	"data_source" text,
	"last_enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "facility_news" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"headline" text NOT NULL,
	"summary" text,
	"source_url" text,
	"source_name" text,
	"published_at" timestamp with time zone,
	"raw_content" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "facility_procurement" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"gpo_name" text,
	"gpo_tier" text,
	"idn_system" text,
	"vac_cadence" text,
	"fiscal_year_end" text,
	"capital_threshold_board" bigint,
	"capital_threshold_cfo" bigint,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_procurement_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_research" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"active_trials_count" integer DEFAULT 0,
	"active_trials_imaging" jsonb DEFAULT '[]'::jsonb,
	"nih_grants_active" integer DEFAULT 0,
	"nih_grant_total_value" bigint,
	"hrsa_grants_active" integer DEFAULT 0,
	"gme_slots" integer,
	"pubmed_citation_count" integer DEFAULT 0,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_research_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_tech_stack" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"ehr_vendor" text,
	"ehr_go_live_date" date,
	"pacs_vendor" text,
	"ris_vendor" text,
	"himss_emram_score" smallint,
	"teleradiology_partner" text,
	"last_updated" timestamp with time zone DEFAULT now(),
	CONSTRAINT "facility_tech_stack_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "facility_workforce" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"active_imaging_job_posts" integer DEFAULT 0,
	"radiology_dir_open" boolean DEFAULT false,
	"csuite_changes" jsonb DEFAULT '[]'::jsonb,
	"fte_total" integer,
	"fte_yoy_delta" numeric(6, 2),
	"biomed_fte_count" integer,
	"last_job_scrape_at" timestamp with time zone,
	CONSTRAINT "facility_workforce_facility_id_unique" UNIQUE("facility_id")
);
--> statement-breakpoint
CREATE TABLE "financial_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"fiscal_year" smallint NOT NULL,
	"source_url" text,
	"raw_text" text,
	"parsed_json" jsonb,
	"total_revenue" bigint,
	"operating_income" bigint,
	"operating_margin_pct" numeric(6, 2),
	"capital_expenditures" bigint,
	"long_term_debt" bigint,
	"days_cash_on_hand" numeric(8, 2),
	"net_patient_revenue" bigint,
	"ingested_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "purchase_signals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid NOT NULL,
	"signal_type" "signal_type" NOT NULL,
	"signal_value" text,
	"confidence" smallint DEFAULT 50,
	"source" text NOT NULL,
	"source_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "radiation_equipment_registry" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"facility_id" uuid,
	"state" char(2) NOT NULL,
	"equipment_type" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"registration_number" text,
	"registration_date" date,
	"last_inspection_date" date,
	"registration_expiry" date,
	"source" text DEFAULT 'state_radiation_control',
	"raw_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "account_contact_engagement" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"engagement_score" smallint DEFAULT 0,
	"replies_count" smallint DEFAULT 0,
	"bounces_count" smallint DEFAULT 0,
	"opens_count" smallint DEFAULT 0,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "account_facilities" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"sub_account_id" uuid,
	"status" text DEFAULT 'identified',
	"priority" smallint DEFAULT 5,
	"deal_score" smallint DEFAULT 0,
	"engagement_score" smallint DEFAULT 0,
	"notes" text,
	"tags" text[] DEFAULT '{}',
	"crm_company_id" text,
	"crm_deal_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan_tier" "plan_tier" DEFAULT 'starter',
	"default_crm" "crm_type" DEFAULT 'ghl',
	"batch_limit_daily" integer DEFAULT 10,
	"status" text DEFAULT 'trial',
	"trial_ends_at" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "campaign_contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"score" smallint DEFAULT 0,
	"sequence_id" uuid,
	"status" text DEFAULT 'queued',
	"enrolled_at" timestamp with time zone,
	"crm_contact_id" text,
	"crm_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"sub_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filter_criteria" jsonb DEFAULT '{}'::jsonb,
	"batch_size_daily" integer DEFAULT 10,
	"status" text DEFAULT 'draft',
	"start_date" timestamp,
	"end_date" timestamp,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "con_alert_notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"con_filing_id" uuid NOT NULL,
	"state" char(2) NOT NULL,
	"modality" text,
	"status_normalized" text,
	"applicant_name" text,
	"facility_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "con_alert_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"states" text[] DEFAULT '{}' NOT NULL,
	"modalities" text[] DEFAULT '{}' NOT NULL,
	"status_filter" text DEFAULT 'any' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_processed_at" timestamp with time zone,
	"last_processed_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_key_rotation_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"run_id" uuid NOT NULL,
	"sub_account_id" uuid,
	"status" text NOT NULL,
	"from_kid" text,
	"to_kid" text,
	"decrypted_with_previous" boolean DEFAULT false,
	"dry_run" boolean DEFAULT false,
	"error_message" text,
	"performed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "enrichment_source_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"source" "enrichment_source" NOT NULL,
	"approved" boolean DEFAULT false,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"notes" text,
	"monthly_budget_limit" bigint,
	"current_month_spend" bigint DEFAULT 0,
	"spend_period_start" timestamp with time zone DEFAULT date_trunc('month', now()) NOT NULL,
	"last_reset_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "enrichment_source_approvals_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "enrichment_source_spend_history" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"source" "enrichment_source" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_spend_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sub_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"crm_type" "crm_type",
	"crm_credentials" jsonb DEFAULT '{}'::jsonb,
	"crm_sub_id" text,
	"batch_size_daily" integer DEFAULT 10,
	"batch_warmup_mode" boolean DEFAULT true,
	"rep_user_id" uuid,
	"rep_name" text,
	"rep_email" text,
	"timezone" text DEFAULT 'America/Chicago',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid,
	"clerk_user_id" text,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"role" text NOT NULL,
	"is_active" boolean DEFAULT true,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "contact_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"campaign_contact_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"current_step" smallint DEFAULT 0,
	"status" "enrollment_status" DEFAULT 'active',
	"enrolled_at" timestamp with time zone DEFAULT now(),
	"last_step_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"reply_received_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_contacts_map" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"local_contact_id" uuid NOT NULL,
	"crm_type" "crm_type" NOT NULL,
	"crm_contact_id" text NOT NULL,
	"crm_company_id" text,
	"crm_deal_id" text,
	"last_synced_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "draft_edits" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"draft_id" uuid NOT NULL,
	"edited_by" uuid,
	"field_changed" text,
	"original_value" text,
	"new_value" text,
	"edit_reason" text,
	"edited_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"enrollment_id" uuid,
	"step_id" uuid,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"channel" "outreach_channel" DEFAULT 'email',
	"subject" text,
	"body" text NOT NULL,
	"linkedin_note" text,
	"linkedin_message" text,
	"personalization_applied" jsonb DEFAULT '{}'::jsonb,
	"ai_model" text,
	"ai_prompt_version" text,
	"generation_tokens" integer,
	"status" "draft_status" DEFAULT 'pending',
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"crm_draft_id" text,
	"crm_synced_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "reply_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"draft_id" uuid,
	"crm_type" "crm_type",
	"crm_contact_id" text,
	"event_type" text,
	"raw_payload" jsonb,
	"ai_classification" text,
	"received_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "report_outputs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"run_id" uuid NOT NULL,
	"format" text NOT NULL,
	"storage_path" text NOT NULL,
	"file_size_kb" integer,
	"download_url" text,
	"expires_at" timestamp with time zone DEFAULT NOW() + INTERVAL '7 days',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"template_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"triggered_by" text DEFAULT 'manual',
	"triggered_by_user" uuid,
	"runtime_filters" jsonb DEFAULT '{}'::jsonb,
	"status" "report_status" DEFAULT 'queued',
	"row_count" integer,
	"duration_ms" integer,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now(),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"template_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"cron_expr" text NOT NULL,
	"timezone" text DEFAULT 'America/Chicago',
	"recipients" text[] DEFAULT '{}',
	"crm_attach" boolean DEFAULT false,
	"export_format" text DEFAULT 'pdf',
	"is_active" boolean DEFAULT true,
	"next_run_at" timestamp with time zone,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"data_sources" text[] NOT NULL,
	"field_config" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filter_config" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_config" jsonb DEFAULT '{}'::jsonb,
	"viz_type" text DEFAULT 'table',
	"export_formats" text[] DEFAULT ARRAY['pdf','csv','xlsx']::text[],
	"schedulable" boolean DEFAULT true,
	"crm_attachable" boolean DEFAULT false,
	"is_system_template" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"step_num" smallint NOT NULL,
	"channel" "outreach_channel" DEFAULT 'email',
	"delay_days" smallint DEFAULT 0,
	"subject_line" text,
	"body_template" text,
	"linkedin_note" text,
	"linkedin_message" text,
	"personalization_hooks" jsonb DEFAULT '{}'::jsonb,
	"variant" char(1) DEFAULT 'A',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"campaign_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"channel" "outreach_channel" DEFAULT 'email',
	"total_steps" smallint DEFAULT 0,
	"is_ai_generated" boolean DEFAULT false,
	"template_vars" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sync_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"sub_account_id" uuid NOT NULL,
	"campaign_id" uuid,
	"crm_type" "crm_type" NOT NULL,
	"batch_date" date NOT NULL,
	"target_count" integer DEFAULT 0,
	"pushed_count" integer DEFAULT 0,
	"failed_count" integer DEFAULT 0,
	"status" "sync_status" DEFAULT 'pending',
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_log" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sync_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"batch_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"entity_type" text,
	"local_id" uuid NOT NULL,
	"crm_id" text,
	"crm_type" "crm_type",
	"crm_response" jsonb,
	"status" text DEFAULT 'pending',
	"error_message" text,
	"pushed_at" timestamp with time zone,
	"retry_count" smallint DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE "con_filings" ADD CONSTRAINT "con_filings_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_enrichment_queue" ADD CONSTRAINT "contact_enrichment_queue_contact_id_facility_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."facility_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_validation_log" ADD CONSTRAINT "contact_validation_log_contact_id_facility_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."facility_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_records" ADD CONSTRAINT "equipment_records_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_records" ADD CONSTRAINT "equipment_records_source_doc_id_financial_documents_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."financial_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_accreditation" ADD CONSTRAINT "facility_accreditation_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_clinical_volume" ADD CONSTRAINT "facility_clinical_volume_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_community" ADD CONSTRAINT "facility_community_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_competitive" ADD CONSTRAINT "facility_competitive_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_compliance" ADD CONSTRAINT "facility_compliance_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_construction" ADD CONSTRAINT "facility_construction_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_contacts" ADD CONSTRAINT "facility_contacts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_news" ADD CONSTRAINT "facility_news_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_procurement" ADD CONSTRAINT "facility_procurement_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_research" ADD CONSTRAINT "facility_research_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_tech_stack" ADD CONSTRAINT "facility_tech_stack_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_workforce" ADD CONSTRAINT "facility_workforce_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_documents" ADD CONSTRAINT "financial_documents_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_signals" ADD CONSTRAINT "purchase_signals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radiation_equipment_registry" ADD CONSTRAINT "radiation_equipment_registry_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_engagement" ADD CONSTRAINT "account_contact_engagement_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_facilities" ADD CONSTRAINT "account_facilities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_facilities" ADD CONSTRAINT "account_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_facilities" ADD CONSTRAINT "account_facilities_sub_account_id_sub_accounts_id_fk" FOREIGN KEY ("sub_account_id") REFERENCES "public"."sub_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_contact_id_facility_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."facility_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_sub_account_id_sub_accounts_id_fk" FOREIGN KEY ("sub_account_id") REFERENCES "public"."sub_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "con_alert_notifications" ADD CONSTRAINT "con_alert_notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "con_alert_notifications" ADD CONSTRAINT "con_alert_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "con_alert_notifications" ADD CONSTRAINT "con_alert_notifications_subscription_id_con_alert_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."con_alert_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "con_alert_subscriptions" ADD CONSTRAINT "con_alert_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "con_alert_subscriptions" ADD CONSTRAINT "con_alert_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_key_rotation_events" ADD CONSTRAINT "crm_key_rotation_events_sub_account_id_sub_accounts_id_fk" FOREIGN KEY ("sub_account_id") REFERENCES "public"."sub_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_key_rotation_events" ADD CONSTRAINT "crm_key_rotation_events_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_source_approvals" ADD CONSTRAINT "enrichment_source_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_rep_user_id_users_id_fk" FOREIGN KEY ("rep_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_enrollments" ADD CONSTRAINT "contact_enrollments_campaign_contact_id_campaign_contacts_id_fk" FOREIGN KEY ("campaign_contact_id") REFERENCES "public"."campaign_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_enrollments" ADD CONSTRAINT "contact_enrollments_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_enrollments" ADD CONSTRAINT "contact_enrollments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts_map" ADD CONSTRAINT "crm_contacts_map_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts_map" ADD CONSTRAINT "crm_contacts_map_local_contact_id_facility_contacts_id_fk" FOREIGN KEY ("local_contact_id") REFERENCES "public"."facility_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_edits" ADD CONSTRAINT "draft_edits_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_edits" ADD CONSTRAINT "draft_edits_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_enrollment_id_contact_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."contact_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_step_id_sequence_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_contact_id_facility_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."facility_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_events" ADD CONSTRAINT "reply_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_events" ADD CONSTRAINT "reply_events_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_outputs" ADD CONSTRAINT "report_outputs_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_triggered_by_user_users_id_fk" FOREIGN KEY ("triggered_by_user") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_last_run_id_report_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."report_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_sub_account_id_sub_accounts_id_fk" FOREIGN KEY ("sub_account_id") REFERENCES "public"."sub_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_batch_id_sync_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."sync_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_con_filings_state_url" ON "con_filings" USING btree ("state","filing_url");--> statement-breakpoint
CREATE INDEX "idx_con_filings_facility" ON "con_filings" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "idx_con_filings_review_status" ON "con_filings" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "idx_enrich_queue_status" ON "contact_enrichment_queue" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_val_log_contact" ON "contact_validation_log" USING btree ("contact_id","checked_at");--> statement-breakpoint
CREATE INDEX "idx_equip_facility" ON "equipment_records" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "idx_equip_modality" ON "equipment_records" USING btree ("modality");--> statement-breakpoint
CREATE INDEX "idx_equip_urgency" ON "equipment_records" USING btree ("urgency_tier");--> statement-breakpoint
CREATE INDEX "idx_facilities_state" ON "facilities" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_facilities_type" ON "facilities" USING btree ("facility_type");--> statement-breakpoint
CREATE INDEX "idx_facilities_signal_score" ON "facilities" USING btree ("signal_score");--> statement-breakpoint
CREATE INDEX "idx_facilities_name_trgm" ON "facilities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_facilities_dba_trgm" ON "facilities" USING gin ("doing_business_as" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_facilities_system_name_trgm" ON "facilities" USING gin ("system_name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_clinical_volume" ON "facility_clinical_volume" USING btree ("facility_id","cms_year");--> statement-breakpoint
CREATE INDEX "idx_contacts_facility" ON "facility_contacts" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_confidence" ON "facility_contacts" USING btree ("confidence_score");--> statement-breakpoint
CREATE INDEX "idx_news_facility" ON "facility_news" USING btree ("facility_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_docs" ON "financial_documents" USING btree ("facility_id","doc_type","fiscal_year");--> statement-breakpoint
CREATE INDEX "idx_fin_docs_facility" ON "financial_documents" USING btree ("facility_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "idx_signals_facility" ON "purchase_signals" USING btree ("facility_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_signals_type" ON "purchase_signals" USING btree ("signal_type");--> statement-breakpoint
CREATE INDEX "idx_signals_detected" ON "purchase_signals" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_rad_reg" ON "radiation_equipment_registry" USING btree ("state","registration_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acct_contact_eng" ON "account_contact_engagement" USING btree ("account_id","contact_id");--> statement-breakpoint
CREATE INDEX "idx_acct_contact_eng_account" ON "account_contact_engagement" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acct_facility" ON "account_facilities" USING btree ("account_id","facility_id");--> statement-breakpoint
CREATE INDEX "idx_acct_facilities_account" ON "account_facilities" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "idx_acct_facilities_sub" ON "account_facilities" USING btree ("sub_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_campaign_contact" ON "campaign_contacts" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "idx_cc_campaign" ON "campaign_contacts" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "idx_cc_account" ON "campaign_contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_account" ON "campaigns" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "idx_campaigns_sub" ON "campaigns" USING btree ("sub_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_con_alert_notif_sub_filing" ON "con_alert_notifications" USING btree ("subscription_id","con_filing_id");--> statement-breakpoint
CREATE INDEX "idx_con_alert_notif_user_unread" ON "con_alert_notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "idx_con_alert_notif_account" ON "con_alert_notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_con_alert_sub_user" ON "con_alert_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_con_alert_sub_account" ON "con_alert_subscriptions" USING btree ("account_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_crm_key_rotation_run" ON "crm_key_rotation_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_crm_key_rotation_sub" ON "crm_key_rotation_events" USING btree ("sub_account_id");--> statement-breakpoint
CREATE INDEX "idx_crm_key_rotation_created" ON "crm_key_rotation_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_spend_history_source_period" ON "enrichment_source_spend_history" USING btree ("source","period_start");--> statement-breakpoint
CREATE INDEX "idx_spend_history_source" ON "enrichment_source_spend_history" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_sub_accounts_account" ON "sub_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_users_account" ON "users" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_enrollments_cc" ON "contact_enrollments" USING btree ("campaign_contact_id");--> statement-breakpoint
CREATE INDEX "idx_enrollments_status" ON "contact_enrollments" USING btree ("status","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_map" ON "crm_contacts_map" USING btree ("account_id","local_contact_id","crm_type");--> statement-breakpoint
CREATE INDEX "idx_crm_map_account" ON "crm_contacts_map" USING btree ("account_id","crm_type");--> statement-breakpoint
CREATE INDEX "idx_draft_edits_draft" ON "draft_edits" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "idx_drafts_account" ON "outreach_drafts" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "idx_drafts_contact" ON "outreach_drafts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_drafts_enrollment" ON "outreach_drafts" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "idx_reply_events_account" ON "reply_events" USING btree ("account_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_reply_events_draft" ON "reply_events" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "idx_report_runs_account" ON "report_runs" USING btree ("account_id","queued_at");--> statement-breakpoint
CREATE INDEX "idx_report_schedules_next" ON "report_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_report_templates_account" ON "report_templates" USING btree ("account_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_seq_step_variant" ON "sequence_steps" USING btree ("sequence_id","step_num","variant");--> statement-breakpoint
CREATE INDEX "idx_steps_sequence" ON "sequence_steps" USING btree ("sequence_id","step_num");--> statement-breakpoint
CREATE INDEX "idx_sequences_account" ON "sequences" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_batches_account" ON "sync_batches" USING btree ("account_id","batch_date");--> statement-breakpoint
CREATE INDEX "idx_batches_status" ON "sync_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sync_items_batch" ON "sync_items" USING btree ("batch_id","status");