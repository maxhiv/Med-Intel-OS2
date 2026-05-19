-- =====================================================================
-- MEDINTEL OS — Warehouse extensions
--
-- Additive extensions to medintel_os_schema.sql. Idempotent; run on top of
-- the base schema whenever you receive the relevant crosswalk files.
--
-- Adds:
--   - dim_aco.tin                      — ACO provider TIN (when ACO PUF
--                                        provides it, otherwise NULL).
--   - dim_aco.parent_organization      — friendly name for fuzzy fallback.
--   - ref_ccn_hosp_id (new table)      — CCN ↔ HCUP hosp_id crosswalk so
--                                        PSI-11 rows can be joined to
--                                        facilities by CCN instead of by
--                                        numeric coincidence.
--   - stage_aco_tin_roster (new table) — staging surface for the CMS ACO
--                                        Aligned Beneficiaries / Provider
--                                        roster file (when available).
-- =====================================================================

SET search_path TO medintel, public;
SET client_min_messages = WARNING;

-- ── dim_aco: TIN column for tighter matching ────────────────────────────────
ALTER TABLE dim_aco
    ADD COLUMN IF NOT EXISTS tin VARCHAR(9),
    ADD COLUMN IF NOT EXISTS parent_organization TEXT;

CREATE INDEX IF NOT EXISTS ix_dim_aco_tin ON dim_aco (tin) WHERE tin IS NOT NULL;

COMMENT ON COLUMN dim_aco.tin IS
    'ACO Tax Identification Number (when the ACO Provider Roster file is loaded). '
    'Empty until medintel_os_load_extensions.sql is run with the roster CSV.';

-- ── ref_ccn_hosp_id: CCN ↔ HCUP hosp_id crosswalk ───────────────────────────
-- Source: AHA Annual Survey, or any custom crosswalk you build by joining
-- AHA Hospital Resource Center on Medicare Provider Number. Without this
-- table populated, fact_psi11 stays orphan to dim_facility — the signal
-- scorer falls back to a numeric-CCN best-effort match.
CREATE TABLE IF NOT EXISTS ref_ccn_hosp_id (
    ccn         TEXT    PRIMARY KEY,
    hosp_id     INTEGER NOT NULL,
    source      TEXT,   -- 'aha_survey' | 'custom' | 'public_inferred'
    loaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ref_ccn_hosp_id_hosp ON ref_ccn_hosp_id (hosp_id);

COMMENT ON TABLE ref_ccn_hosp_id IS
    'CCN ↔ HCUP hosp_id crosswalk. Populate by \copy from your crosswalk CSV '
    '(typical schema: ccn, hosp_id, source). Used by the API signal scorer to '
    'attach PSI-11 rates to the right facility regardless of numeric coincidence.';

-- ── stage_aco_tin_roster: staging for the ACO provider TIN file ─────────────
-- CMS publishes ACO Provider Information PUF (sometimes called "ACO Aligned
-- Beneficiaries" or the "Provider TIN Roster") on data.cms.gov. Load it here
-- then run the transform below to populate dim_aco.tin.
CREATE TABLE IF NOT EXISTS stage_aco_tin_roster (
    aco_id              TEXT,
    aco_name            TEXT,
    tin                 TEXT,
    parent_org_name     TEXT,
    state               TEXT,
    source_file         TEXT
);

-- ── Transform: stage_aco_tin_roster → dim_aco.tin ───────────────────────────
-- Safe to run on an empty staging table (the UPDATE will match no rows).
UPDATE dim_aco a
   SET tin                 = COALESCE(a.tin, r.tin),
       parent_organization = COALESCE(a.parent_organization, r.parent_org_name)
  FROM (
    SELECT DISTINCT ON (aco_id)
           NULLIF(aco_id,'')           AS aco_id,
           NULLIF(REGEXP_REPLACE(tin,'\D','','g'),'')::VARCHAR(9) AS tin,
           NULLIF(parent_org_name,'')  AS parent_org_name
      FROM stage_aco_tin_roster
     WHERE aco_id IS NOT NULL AND aco_id <> ''
     ORDER BY aco_id, tin DESC NULLS LAST
  ) r
 WHERE a.aco_id = r.aco_id;

-- ── View: v_aco_tin_matches (convenience) ───────────────────────────────────
CREATE OR REPLACE VIEW v_aco_tin_matches AS
SELECT a.aco_id, a.aco_name, a.tin, a.parent_organization
  FROM dim_aco a
 WHERE a.tin IS NOT NULL;
