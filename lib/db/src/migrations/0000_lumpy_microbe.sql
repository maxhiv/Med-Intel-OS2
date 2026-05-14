-- =============================================================================
-- Task #67 incremental migrations: Phases 0-2 & 9
--
-- Applied to the database via `drizzle-kit push --force`. This file re-applies
-- only the CHANGES introduced by Task #67 and is safe to run on any existing
-- database — all statements use IF NOT EXISTS / ADD VALUE IF NOT EXISTS.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 1: New signal_type enum values
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'bond_issued';
ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'rfp_posted';
ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'hcris_depreciation_spike';
ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'high_utilization';
ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'equipment_age_7yr';
ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'adverse_event_spike';
ALTER TYPE "public"."signal_type" ADD VALUE IF NOT EXISTS 'sec_capex_flag';

-- ---------------------------------------------------------------------------
-- Phase 9: data_source column on facility_contacts
-- ---------------------------------------------------------------------------

ALTER TABLE "facility_contacts"
  ADD COLUMN IF NOT EXISTS "data_source" text;

-- ---------------------------------------------------------------------------
-- Phase 0: Backfill account_facilities (link every facility to every account)
-- Idempotent via ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------

INSERT INTO account_facilities (account_id, facility_id)
SELECT a.id, f.id
FROM accounts a
CROSS JOIN facilities f
ON CONFLICT (account_id, facility_id) DO NOTHING;
