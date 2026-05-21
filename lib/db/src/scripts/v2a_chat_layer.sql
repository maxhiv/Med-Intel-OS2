-- v2a_chat_layer.sql — RLS for the v2.0 chat-first layer.
--
-- Companion to lib/db/src/schema/chat.ts. Drizzle `push` creates the tables
-- but does NOT manage row-level security, so the policies live here — same
-- split as v2_opportunity_rls.sql.
--
-- Run via:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/src/scripts/v2a_chat_layer.sql
-- Or through the orchestrator:
--   bash lib/db/src/scripts/v2_install.sh
--
-- Idempotent: ENABLE RLS is a no-op if already on; policy creation is wrapped
-- in DO blocks that swallow duplicate_object.

BEGIN;

-- The `app_rls` runtime role (created by v2_opportunity_rls.sql; re-asserted
-- here so this script also works standalone on a fresh DB).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN;
  END IF;
END $$;

-- ─── Account-scoped tables ──────────────────────────────────────────────────
-- chat_sessions, chat_cost_daily, paid_source_approvals, paid_source_call_log,
-- agent_usage_limits, agent_usage_daily, sub_agent_invocations all carry
-- account_id directly.

ALTER TABLE chat_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_cost_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE paid_source_approvals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE paid_source_call_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_usage_limits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_usage_daily      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_agent_invocations  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY chat_sessions_tenant_isolation ON chat_sessions
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY chat_cost_daily_tenant_isolation ON chat_cost_daily
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY paid_source_approvals_tenant_isolation ON paid_source_approvals
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY paid_source_call_log_tenant_isolation ON paid_source_call_log
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY agent_usage_limits_tenant_isolation ON agent_usage_limits
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY agent_usage_daily_tenant_isolation ON agent_usage_daily
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY sub_agent_invocations_tenant_isolation ON sub_agent_invocations
    USING (account_id = current_setting('app.account_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Session-scoped tables ──────────────────────────────────────────────────
-- chat_messages + chat_session_prospects don't carry account_id; they isolate
-- by joining to chat_sessions, which is itself RLS-filtered. The subquery
-- therefore only ever sees the caller's own sessions.

ALTER TABLE chat_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_session_prospects ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY chat_messages_tenant_isolation ON chat_messages
    USING (session_id IN (SELECT id FROM chat_sessions));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY chat_session_prospects_tenant_isolation ON chat_session_prospects
    USING (session_id IN (SELECT id FROM chat_sessions));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- The API connects, then SET ROLE app_rls inside each request transaction.
-- sub_agent_registry + user_role_changes are intentionally NOT RLS-scoped
-- (global catalog / cross-account operator audit) but still need grants.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  chat_sessions, chat_messages, chat_session_prospects, chat_cost_daily,
  paid_source_approvals, paid_source_call_log, agent_usage_limits,
  agent_usage_daily, sub_agent_registry, sub_agent_invocations,
  user_role_changes
TO app_rls;

GRANT USAGE, SELECT ON
  chat_messages_id_seq, paid_source_call_log_id_seq,
  sub_agent_invocations_id_seq, user_role_changes_id_seq
TO app_rls;

COMMIT;
