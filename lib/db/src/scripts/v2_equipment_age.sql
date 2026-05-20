-- =====================================================================
-- MedIntel OS v2.0 · Phase D · Equipment-age inference
--
-- Companion script for the Drizzle-managed tables in
-- lib/db/src/schema/confidence.ts. Run ONCE after
-- `pnpm --filter @workspace/db run push` has created the new tables.
--
--   psql "$DATABASE_URL" -f lib/db/src/scripts/v2_equipment_age.sql
--
-- Installs the v_equipment_age_inferred view that consolidates
-- equipment_age_evidence rows into a weighted-average best-estimate
-- install year per (facility, modality, manufacturer), with an
-- age_confidence in [0, 1] that rises with source count and total
-- evidence weight.
-- =====================================================================

BEGIN;

CREATE OR REPLACE VIEW v_equipment_age_inferred AS
WITH ev AS (
  SELECT
    facility_id,
    modality,
    COALESCE(manufacturer, 'unknown') AS manufacturer,
    SUM(inferred_install_year::numeric * evidence_weight) /
      NULLIF(SUM(evidence_weight), 0) AS weighted_install_year,
    SUM(evidence_weight)         AS total_weight,
    COUNT(*)                     AS evidence_count,
    COUNT(DISTINCT evidence_type) AS distinct_source_count,
    ARRAY_AGG(DISTINCT evidence_type ORDER BY evidence_type) AS evidence_types,
    MAX(observed_at)             AS last_evidence_at
  FROM equipment_age_evidence
  WHERE inferred_install_year IS NOT NULL
  GROUP BY facility_id, modality, manufacturer
)
SELECT
  ev.facility_id,
  ev.modality,
  ev.manufacturer,
  ev.weighted_install_year,
  ROUND(ev.weighted_install_year)::INT                                   AS estimated_install_year,
  EXTRACT(YEAR FROM CURRENT_DATE)::INT - ROUND(ev.weighted_install_year)::INT
                                                                          AS estimated_age_years,
  ev.total_weight,
  ev.evidence_count,
  ev.distinct_source_count,
  ev.evidence_types,
  ev.last_evidence_at,
  -- Confidence rises with total weight (capped at 0.6 contribution) and
  -- distinct-source count (capped at 0.4 contribution). Single-source
  -- evidence tops out at ~0.6 — provisional in the UI.
  LEAST(1.0,
        LEAST(0.6, ev.total_weight * 0.6) +
        LEAST(0.4, ev.distinct_source_count::numeric * 0.10)
  )                                                                       AS age_confidence
FROM ev;

COMMENT ON VIEW v_equipment_age_inferred IS
    'v2.0 equipment-age engine. Weighted-average install year per (facility, modality, manufacturer), with age_confidence in [0,1].';

COMMIT;

-- Smoke checks:
--   SELECT count(*) FROM information_schema.views WHERE table_name = 'v_equipment_age_inferred'; -- expected: 1
--   -- After loading a registry extract via stage_state_registry_radiation:
--   SELECT * FROM v_equipment_age_inferred ORDER BY age_confidence DESC LIMIT 10;
