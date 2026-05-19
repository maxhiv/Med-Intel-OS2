-- =====================================================================
-- MEDINTEL OS — Database role grants
--
-- The Express API runs every authenticated request inside a Postgres
-- transaction with `SET LOCAL ROLE app_rls` so row-level security policies
-- on tenant tables apply (see lib/db/src/index.ts). app_rls is NOT a
-- BYPASSRLS / superuser role, which means it needs explicit grants on the
-- read-only `medintel` warehouse schema or the intelligence endpoint will
-- fail with "permission denied for schema medintel".
--
-- Run this file once, AFTER medintel_os_schema.sql has created the schema.
-- Idempotent — safe to re-run.
-- =====================================================================

DO $$
BEGIN
    -- Some Postgres deployments name their RLS role differently; only grant
    -- when the conventional one exists so this script doesn't fail in CI
    -- environments where the app DB hasn't been provisioned with RLS yet.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
        GRANT USAGE ON SCHEMA medintel TO app_rls;
        GRANT SELECT ON ALL TABLES IN SCHEMA medintel TO app_rls;
        -- Future tables created in the schema also default-grant.
        ALTER DEFAULT PRIVILEGES IN SCHEMA medintel GRANT SELECT ON TABLES TO app_rls;
    ELSE
        RAISE NOTICE 'app_rls role not found — skipping medintel grants.';
    END IF;
END $$;
