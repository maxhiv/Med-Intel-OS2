-- =====================================================================
-- MedIntel OS v2.0 · Phase E · Opportunity Inbox — RLS policy
--
-- Run ONCE after `pnpm --filter @workspace/db run push` has created the
-- opportunities + opportunity_actions tables.
--
--   psql "$DATABASE_URL" -f lib/db/src/scripts/v2_opportunity_rls.sql
--
-- Enforces tenant isolation: every authenticated request sets
-- `app.account_id` via the existing rlsTransaction middleware; this
-- policy filters opportunities to that account.
-- =====================================================================

BEGIN;

-- The `app_rls` role is the runtime grantee that the API connects as when
-- RLS is enforced (see lib/db's withRLS). On a fresh DB the role may not
-- exist yet — create it idempotently so `pnpm seed:all` / `v2_install.sh`
-- succeeds on first run. The role is intentionally NOLOGIN — it's only
-- meant to receive GRANTs that the API role will inherit via SET ROLE.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN;
  END IF;
END $$;

ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY opportunities_tenant_isolation ON opportunities
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE opportunity_actions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY opportunity_actions_tenant_isolation ON opportunity_actions
    USING (
      EXISTS (
        SELECT 1 FROM opportunities o
        WHERE o.id = opportunity_actions.opportunity_id
          AND o.account_id = current_setting('app.account_id', true)::uuid
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON opportunities TO app_rls;
GRANT SELECT, INSERT ON opportunity_actions TO app_rls;
GRANT USAGE, SELECT ON SEQUENCE opportunity_actions_id_seq TO app_rls;

COMMIT;
