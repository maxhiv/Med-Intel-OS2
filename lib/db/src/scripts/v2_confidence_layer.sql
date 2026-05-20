-- =====================================================================
-- MedIntel OS v2.0 · Phase B · Confidence + Citation Foundation
--
-- Idempotent companion script for the Drizzle-managed schema in
-- lib/db/src/schema/confidence.ts. Run ONCE after
-- `pnpm --filter @workspace/db run push` has created the new tables.
--
--   psql "$DATABASE_URL" -f lib/db/src/scripts/v2_confidence_layer.sql
--
-- What this script does:
--   1. Installs the compute_claim_confidence() PL/pgSQL function with the
--      180-day default half-life decay (verbatim from handoff migration 013).
--   2. Asserts the FK from equipment_source_citations.equipment_record_id
--      to equipment_records.id (deferred from schema TS to avoid a circular
--      import — see comment in confidence.ts).
--   3. Seeds the canonical 35-row source_weights catalog (ON CONFLICT
--      UPDATE so re-runs refresh any tuned weights).
--   4. Seeds the starter manufacturer_eol_catalog (~25 OEM models — ON
--      CONFLICT DO NOTHING so manual edits survive re-seed).
-- =====================================================================

BEGIN;

-- ── 1. compute_claim_confidence() ──────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_claim_confidence(
  p_entity_table TEXT,
  p_entity_id    UUID,
  p_claim_field  TEXT,
  p_claim_value  TEXT
) RETURNS NUMERIC AS $$
DECLARE
  v_confidence NUMERIC;
BEGIN
  SELECT LEAST(1.0,
    SUM(
      source_weight *
      -- 180-day half-life decay
      EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - observed_at)) / (180 * 86400))
    )
  ) INTO v_confidence
  FROM intelligence_claims
  WHERE entity_table = p_entity_table
    AND entity_id   = p_entity_id
    AND claim_field = p_claim_field
    AND claim_value = p_claim_value
    AND contradicted_by IS NULL;
  RETURN COALESCE(v_confidence, 0);
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION compute_claim_confidence IS
    'v2.0 confidence layer. Returns a 0..1 time-decayed score for a (table, id, field, value) tuple, summed over all uncontradicted intelligence_claims. 180-day default half-life.';

-- ── 2. equipment_source_citations FK ───────────────────────────────────
DO $$ BEGIN
  ALTER TABLE equipment_source_citations
    ADD CONSTRAINT fk_equipment_source_citations_record
    FOREIGN KEY (equipment_record_id)
    REFERENCES equipment_records(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. source_weights canonical catalog ────────────────────────────────
INSERT INTO source_weights (source_type, default_weight, description, notes) VALUES
  ('state_radiation_registry',  0.95, 'State radiation control program registry',     'Government, ground truth for X-ray/CT/mammo install year'),
  ('fda_maude',                 0.90, 'FDA OpenFDA / MAUDE recalls and listings',     'Federal, authoritative for recalls'),
  ('cms_hcris_a7',              0.85, 'CMS HCRIS Worksheet A-7 movable equipment',    'Federal cost report; asset-class level not specific units'),
  ('irs_990_schedule_d',        0.80, 'IRS Form 990 Schedule D',                      'Federal; 12-18 month lag'),
  ('emma_bond_filing',          0.85, 'MSRB EMMA municipal bond Official Statement',  'Investor-grade disclosure'),
  ('state_con_filing',          0.90, 'State Certificate of Need filing',             'Public, attorney-reviewed'),
  ('acr_accreditation',         0.85, 'ACR accreditation lookup',                     'Body-verified'),
  ('iac_accreditation',         0.85, 'IAC accreditation lookup',                     'Body-verified'),
  ('aaahc_accreditation',       0.85, 'AAAHC accreditation lookup',                   'Body-verified'),
  ('aaaasf_accreditation',      0.85, 'AAAASF accreditation lookup',                  'Body-verified'),
  ('aaha_accreditation',        0.85, 'AAHA accreditation lookup',                    'Body-verified (vet)'),
  ('manufacturer_eol_bulletin', 0.80, 'OEM end-of-life announcement',                 'May be marketing — still highly predictive'),
  ('hospital_press_release',    0.55, 'Hospital-issued press release',                'Self-reported, often aspirational'),
  ('job_posting_single',        0.30, 'Single job posting',                           'Weak alone'),
  ('job_posting_velocity',      0.65, '3+ postings in 60 days',                       'Strong scaling indicator'),
  ('linkedin_profile',          0.50, 'LinkedIn profile',                             'Titles change frequently'),
  ('outscraper_enrichment',     0.55, 'Outscraper aggregated data',                   'Verify with primary source'),
  ('rep_field_report',          0.75, 'Rep firsthand observation',                    'High weight if recent and well-logged'),
  ('definitive_healthcare',     0.85, 'Definitive Healthcare API (if licensed)',      'Authoritative facility data'),
  ('npi_registry',              0.90, 'CMS NPPES NPI Registry',                       'Federal, ground truth for provider identity'),
  ('cms_provider_data',         0.90, 'CMS Provider Data Catalog',                    'Federal'),
  ('propublica_990',            0.80, 'ProPublica Nonprofit Explorer',                'Aggregated 990 data'),
  ('clinicaltrials_gov',        0.85, 'ClinicalTrials.gov',                           'Federal trial registry'),
  ('nih_reporter',              0.85, 'NIH RePORTER grant database',                  'Federal'),
  ('hrsa_grant_award',          0.90, 'HRSA grant award announcement',                'Federal'),
  ('usda_rd_loan',              0.90, 'USDA Rural Development loan',                  'Federal'),
  ('340b_opais',                0.85, 'HRSA OPAIS 340B enrollment',                   'Federal'),
  ('cms_asc_list',              0.95, 'CMS ASC Covered Procedures List',              'Federal, annual update'),
  ('cms_cah_list',              0.95, 'CMS CAH designation list',                     'Federal, monthly refresh'),
  ('cms_physician_compare',     0.90, 'CMS Physician Compare procedure volumes',      'Federal'),
  ('usda_aphis',                0.75, 'USDA APHIS vet facility license',              'Federal'),
  ('hospital_website_scrape',   0.50, 'Hospital website parse',                       'Self-published, varies in accuracy'),
  ('chna_report',               0.75, 'Community Health Needs Assessment',            'Hospital-published per IRS §501(r)'),
  ('press_release_aggregator',  0.55, 'NewsAPI / GDELT / Google News',                'Distill from press releases'),
  ('county_building_permit',    0.70, 'County / city building permit',                'Public; capital signal'),
  ('manual_curator',            0.85, 'Manually verified by team',                    'Human-in-the-loop'),
  ('web_scrape_generic',        0.40, 'Generic web scrape',                           'Floor for unverified web content'),
  -- v2.0 medintel warehouse signal types
  ('medintel_warehouse',        0.85, 'medintel.* warehouse (PECOS, HCRIS, CHOW)',    'Federal CMS data — high trust')
ON CONFLICT (source_type) DO UPDATE SET
  default_weight = EXCLUDED.default_weight,
  description    = EXCLUDED.description,
  notes          = EXCLUDED.notes,
  updated_at     = NOW();

-- ── 4. manufacturer_eol_catalog starter set ────────────────────────────
INSERT INTO manufacturer_eol_catalog (manufacturer, modality, model, generation, market_release_year, service_end_date, parts_end_date, software_eol_date, successor_model, source_url) VALUES
  -- GE Healthcare CT
  ('GE Healthcare', 'CT', 'LightSpeed VCT',   'pre-Revolution', 2004, '2019-12-31', '2021-12-31', '2018-12-31', 'Revolution Apex',    'https://www.gehealthcare.com/support'),
  ('GE Healthcare', 'CT', 'LightSpeed Pro',   'pre-Revolution', 2002, '2017-12-31', '2019-12-31', '2016-12-31', 'Revolution EVO',     'https://www.gehealthcare.com/support'),
  ('GE Healthcare', 'CT', 'BrightSpeed Elite','BrightSpeed',    2008, '2021-12-31', '2023-12-31', '2020-12-31', 'Revolution Maxima',  'https://www.gehealthcare.com/support'),
  ('GE Healthcare', 'CT', 'Optima CT660',     'Optima',         2009, '2023-12-31', '2025-12-31', NULL,         'Revolution Apex',    'https://www.gehealthcare.com/support'),
  -- GE Healthcare MR
  ('GE Healthcare', 'MRI', 'Signa HDxt 1.5T', 'HDxt',           2008, '2022-12-31', '2024-12-31', NULL, 'SIGNA Voyager',  'https://www.gehealthcare.com/support'),
  ('GE Healthcare', 'MRI', 'Signa HDxt 3.0T', 'HDxt',           2008, '2022-12-31', '2024-12-31', NULL, 'SIGNA Premier',  'https://www.gehealthcare.com/support'),
  ('GE Healthcare', 'MRI', 'Optima MR450w',   'Optima',         2010, '2024-12-31', '2026-12-31', NULL, 'SIGNA Artist',   'https://www.gehealthcare.com/support'),
  -- Siemens CT
  ('Siemens Healthineers', 'CT', 'SOMATOM Sensation 64', 'Sensation',  2005, '2018-06-30', '2020-12-31', NULL, 'SOMATOM go.Top', 'https://www.siemens-healthineers.com/services'),
  ('Siemens Healthineers', 'CT', 'SOMATOM Definition AS','Definition', 2008, '2022-12-31', '2024-12-31', NULL, 'SOMATOM X.cite', 'https://www.siemens-healthineers.com/services'),
  ('Siemens Healthineers', 'CT', 'SOMATOM Emotion 16',   'Emotion',    2007, '2020-06-30', '2022-12-31', NULL, 'SOMATOM go.Now', 'https://www.siemens-healthineers.com/services'),
  -- Siemens MR
  ('Siemens Healthineers', 'MRI', 'MAGNETOM Avanto 1.5T', 'Avanto',    2004, '2020-12-31', '2023-12-31', NULL, 'MAGNETOM Sola',  'https://www.siemens-healthineers.com/services'),
  ('Siemens Healthineers', 'MRI', 'MAGNETOM Espree 1.5T', 'Espree',    2006, '2021-12-31', '2024-12-31', NULL, 'MAGNETOM Altea', 'https://www.siemens-healthineers.com/services'),
  ('Siemens Healthineers', 'MRI', 'MAGNETOM Verio 3.0T',  'Verio',     2007, '2022-12-31', '2024-12-31', NULL, 'MAGNETOM Vida',  'https://www.siemens-healthineers.com/services'),
  -- Philips CT
  ('Philips', 'CT', 'Brilliance 64',  'Brilliance', 2005, '2018-12-31', '2020-12-31', NULL, 'Spectral CT 7500', 'https://www.philips.com/healthcare/services'),
  ('Philips', 'CT', 'iCT 256',        'iCT',        2009, '2023-12-31', '2025-12-31', NULL, 'CT 5300',          'https://www.philips.com/healthcare/services'),
  -- Philips MR
  ('Philips', 'MRI', 'Achieva 1.5T',  'Achieva',    2005, '2019-12-31', '2022-12-31', NULL, 'Ingenia Ambition', 'https://www.philips.com/healthcare/services'),
  ('Philips', 'MRI', 'Achieva 3.0T',  'Achieva',    2006, '2020-12-31', '2023-12-31', NULL, 'Ingenia Elition',  'https://www.philips.com/healthcare/services'),
  -- Hologic mammography
  ('Hologic', 'mammo', 'Selenia',                 'Selenia',    2002, '2017-12-31', '2019-12-31', NULL, '3Dimensions',        'https://www.hologic.com/support'),
  ('Hologic', 'mammo', 'Selenia Dimensions',      'Dimensions', 2011, '2024-12-31', '2026-12-31', NULL, '3Dimensions',        'https://www.hologic.com/support'),
  -- Canon (formerly Toshiba) CT
  ('Canon Medical Systems', 'CT', 'Aquilion 64',     'Aquilion', 2004, '2019-12-31', '2021-12-31', NULL, 'Aquilion Lightning', 'https://global.medical.canon/support'),
  ('Canon Medical Systems', 'CT', 'Aquilion Prime',  'Aquilion', 2009, '2023-12-31', '2025-12-31', NULL, 'Aquilion Serve',     'https://global.medical.canon/support'),
  -- Intuitive da Vinci
  ('Intuitive Surgical', 'surgical_robot', 'da Vinci S',  'S',  2006, '2018-12-31', '2020-12-31', NULL, 'da Vinci Xi', 'https://www.intuitive.com/en-us'),
  ('Intuitive Surgical', 'surgical_robot', 'da Vinci Si', 'Si', 2009, '2024-12-31', '2026-12-31', NULL, 'da Vinci Xi', 'https://www.intuitive.com/en-us'),
  -- Stryker Mako
  ('Stryker', 'surgical_robot', 'Mako (1st gen)', '1.0', 2017, NULL, NULL, NULL, 'Mako 4.0', 'https://www.stryker.com/us/en/joint-replacement/products/mako-robotic-arm.html'),
  -- Varian / Elekta linacs
  ('Varian', 'linac', 'Clinac iX', 'Clinac iX', 2004, '2020-12-31', '2023-12-31', NULL, 'TrueBeam', 'https://www.varian.com/support'),
  ('Varian', 'linac', 'TrueBeam',  'TrueBeam',  2010, NULL,         NULL,         NULL, 'Halcyon',  'https://www.varian.com/support'),
  ('Elekta', 'linac', 'Synergy',   'Synergy',   2003, '2020-12-31', '2023-12-31', NULL, 'Versa HD', 'https://www.elekta.com/services')
ON CONFLICT (manufacturer, modality, model) DO NOTHING;

COMMIT;

-- ── Smoke checks ──────────────────────────────────────────────────────
-- Run after COMMIT to verify the install succeeded:
--   SELECT count(*) FROM source_weights;
--     -- expected: >= 38 (37 from handoff + medintel_warehouse)
--   SELECT count(*) FROM manufacturer_eol_catalog;
--     -- expected: >= 27 (the starter set)
--   SELECT compute_claim_confidence('facilities', '00000000-0000-0000-0000-000000000000', 'beds', '150');
--     -- expected: 0 (no claims yet for that synthetic UUID)
