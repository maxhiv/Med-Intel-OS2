-- v2b_con_documents.sql — structured fields scraped from CON filing PDFs.
--
-- The CON ingestor now opens each state CON document (NC DHSR decision/review
-- PDFs) and extracts the structured fields the filename never carried:
-- project id, county, state facility id (FID#), project description, applicant
-- contact, capital expenditure, and the appeal deadline. These columns hold
-- that scraped data; `document_scraped_at` is NULL until a PDF is parsed.
--
-- Idempotent: every statement is ADD COLUMN / CREATE INDEX IF NOT EXISTS.

ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS project_id          text;
ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS county              text;
ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS state_facility_id   text;
ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS project_description text;
ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS applicant_contact   text;
ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS appeal_deadline     date;
ALTER TABLE con_filings ADD COLUMN IF NOT EXISTS document_scraped_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_con_filings_state_facility_id
  ON con_filings (state_facility_id);
