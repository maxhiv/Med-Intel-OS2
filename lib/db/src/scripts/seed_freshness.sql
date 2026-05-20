-- seed_freshness.sql — bulk seed run tracking + staging tables.
--
-- Run via:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/src/scripts/seed_freshness.sql
-- Or via the orchestrator:
--   bash lib/db/src/scripts/v2_install.sh
--
-- Idempotent: every CREATE uses IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Run audit ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS source_seed_runs (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_name       text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       integer,
  status            text NOT NULL,           -- 'running' | 'ok' | 'failed' | 'skipped'
  file_url          text,
  file_sha256       text,
  file_bytes        bigint,
  rows_staged       integer NOT NULL DEFAULT 0,
  rows_upserted     integer NOT NULL DEFAULT 0,
  signals_inserted  integer NOT NULL DEFAULT 0,
  error_message     text,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_source_seed_runs_source_started
  ON source_seed_runs (source_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_seed_runs_sha
  ON source_seed_runs (source_name, file_sha256);

-- ─── HCRIS staging ─────────────────────────────────────────────────────────
-- The CMS Hospital Provider Cost Report dataset (data.cms.gov). One row per
-- provider per fiscal year. We stage the CSV, then transform into the
-- canonical `facilities` enrichment fields + `hcris_depreciation_spike`
-- signals.

CREATE TABLE IF NOT EXISTS hcris_raw (
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  rpt_rec_num         bigint,
  provider_ccn        text,
  fy_bgn_dt           date,
  fy_end_dt           date,
  total_beds          integer,
  net_pat_rev         numeric(18,2),
  total_costs         numeric(18,2),
  net_income          numeric(18,2),
  total_assets        numeric(18,2),
  total_liabilities   numeric(18,2),
  total_equity        numeric(18,2),
  fixed_assets        numeric(18,2),
  depreciation        numeric(18,2),
  total_salaries      numeric(18,2),
  contract_labor      numeric(18,2),
  source_file         text,
  CONSTRAINT hcris_raw_unique UNIQUE (provider_ccn, fy_end_dt)
);

CREATE INDEX IF NOT EXISTS idx_hcris_raw_ccn ON hcris_raw (provider_ccn);
CREATE INDEX IF NOT EXISTS idx_hcris_raw_fy  ON hcris_raw (fy_end_dt DESC);

-- ─── FDA openFDA bulk staging (4 endpoints) ────────────────────────────────
-- Each mirrors the openFDA bulk JSON output's most useful fields. Full row
-- preserved in `raw_json` for replay / audit.

CREATE TABLE IF NOT EXISTS fda_510k_raw (
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  k_number       text PRIMARY KEY,
  applicant      text,
  device_name    text,
  product_code   text,
  decision_date  date,
  decision_code  text,
  clearance_type text,
  raw_json       jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fda_510k_raw_applicant  ON fda_510k_raw (applicant);
CREATE INDEX IF NOT EXISTS idx_fda_510k_raw_decision   ON fda_510k_raw (decision_date DESC);

CREATE TABLE IF NOT EXISTS fda_classification_raw (
  ingested_at                  timestamptz NOT NULL DEFAULT now(),
  product_code                 text PRIMARY KEY,
  device_class                 text,
  device_name                  text,
  medical_specialty            text,
  medical_specialty_description text,
  regulation_number            text,
  submission_type_id           text,
  raw_json                     jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fda_class_raw_specialty ON fda_classification_raw (medical_specialty);

CREATE TABLE IF NOT EXISTS fda_recall_raw (
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  recall_number       text PRIMARY KEY,
  recalling_firm      text,
  product_code        text,
  product_description text,
  recall_initiation_date date,
  reason_for_recall   text,
  status              text,
  classification      text,
  raw_json            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fda_recall_raw_firm ON fda_recall_raw (recalling_firm);
CREATE INDEX IF NOT EXISTS idx_fda_recall_raw_init ON fda_recall_raw (recall_initiation_date DESC);

CREATE TABLE IF NOT EXISTS fda_maude_raw (
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  mdr_report_key     text PRIMARY KEY,
  event_type         text,
  date_received      date,
  product_problems   text[],
  manufacturer_name  text,
  brand_name         text,
  raw_json           jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fda_maude_raw_received  ON fda_maude_raw (date_received DESC);
CREATE INDEX IF NOT EXISTS idx_fda_maude_raw_brand     ON fda_maude_raw (brand_name);

-- ─── ClinicalTrials.gov staging ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clinical_trials_raw (
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  nct_id       text PRIMARY KEY,
  brief_title  text,
  overall_status text,
  start_date   date,
  completion_date date,
  conditions   text[],
  phase        text,
  enrollment   integer,
  sponsor_name text,
  locations    jsonb,
  raw_json     jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ct_raw_status ON clinical_trials_raw (overall_status);
CREATE INDEX IF NOT EXISTS idx_ct_raw_start  ON clinical_trials_raw (start_date DESC);

-- ─── NIH RePORTER staging ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nih_grants_raw (
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  appl_id             bigint PRIMARY KEY,
  project_num         text,
  fiscal_year         integer,
  award_amount        numeric(18,2),
  org_name            text,
  org_city            text,
  org_state           text,
  org_zip             text,
  pi_name             text,
  pi_email            text,
  project_title       text,
  project_start_date  date,
  project_end_date    date,
  award_notice_date   date,
  raw_json            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nih_raw_org_state ON nih_grants_raw (org_state);
CREATE INDEX IF NOT EXISTS idx_nih_raw_org_name  ON nih_grants_raw (org_name);
CREATE INDEX IF NOT EXISTS idx_nih_raw_fy        ON nih_grants_raw (fiscal_year DESC);

-- ─── USA Spending staging ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usa_spending_raw (
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  award_id_piid        text,
  recipient_name       text,
  recipient_uei        text,
  recipient_state_code text,
  recipient_zip        text,
  award_amount         numeric(18,2),
  awarding_agency      text,
  awarding_subagency   text,
  product_or_service_code text,
  naics_code           text,
  period_of_performance_start_date date,
  period_of_performance_current_end_date date,
  raw_json             jsonb NOT NULL,
  PRIMARY KEY (award_id_piid)
);
CREATE INDEX IF NOT EXISTS idx_usa_spending_raw_recipient ON usa_spending_raw (recipient_name);
CREATE INDEX IF NOT EXISTS idx_usa_spending_raw_state     ON usa_spending_raw (recipient_state_code);

-- ─── CMS Provider Data staging (generic) ──────────────────────────────────
-- One row per dataset row keyed by dataset+facility identifier. Most CMS
-- provider datasets identify facilities by CCN or NPI.

CREATE TABLE IF NOT EXISTS cms_provider_raw (
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  dataset_id    text NOT NULL,
  facility_key  text NOT NULL,             -- usually CCN or NPI
  state         text,
  raw_json      jsonb NOT NULL,
  PRIMARY KEY (dataset_id, facility_key)
);
CREATE INDEX IF NOT EXISTS idx_cms_provider_raw_state ON cms_provider_raw (state);
