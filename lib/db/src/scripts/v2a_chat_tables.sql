-- v2a_chat_tables.sql — DDL for the v2.0 chat-first layer.
--
-- Mirrors lib/db/src/schema/chat.ts exactly. Shipped as raw DDL (same
-- pattern as seed_freshness.sql) rather than relying on `drizzle-kit push`
-- because push misreads the unmanaged `*_raw` staging tables as rename
-- candidates for these new tables. Running this script + v2a_chat_layer.sql
-- via v2_install.sh is the supported install path — no `push` required.
--
-- Idempotent: every statement uses IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Chat sessions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_sessions (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  title            text,
  created_at       timestamptz DEFAULT now(),
  last_message_at  timestamptz DEFAULT now(),
  status           text NOT NULL DEFAULT 'active',
  context_summary  text,
  total_tokens_in  bigint DEFAULT 0,
  total_tokens_out bigint DEFAULT 0,
  total_cost_usd   numeric(10,4) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_account_user
  ON chat_sessions (account_id, user_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_active
  ON chat_sessions (account_id, status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role         text NOT NULL,
  content      jsonb NOT NULL,
  tool_calls   jsonb,
  tool_results jsonb,
  token_usage  jsonb,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT chat_messages_role_chk CHECK (role IN ('user','assistant','tool','system'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON chat_messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS chat_session_prospects (
  session_id     uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  surfaced_at    timestamptz DEFAULT now(),
  PRIMARY KEY (session_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_prospects_opp
  ON chat_session_prospects (opportunity_id);

CREATE TABLE IF NOT EXISTS chat_cost_daily (
  account_id       uuid NOT NULL,
  day              date NOT NULL,
  user_id          uuid NOT NULL,
  total_tokens_in  bigint DEFAULT 0,
  total_tokens_out bigint DEFAULT 0,
  total_cost_usd   numeric(10,4) DEFAULT 0,
  message_count    integer DEFAULT 0,
  session_count    integer DEFAULT 0,
  PRIMARY KEY (account_id, day, user_id)
);

-- ─── Paid-source gating ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paid_source_approvals (
  id                         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id                 uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_name                text NOT NULL,
  source_category            text NOT NULL,
  source_tier                text DEFAULT 'paid',
  approved                   boolean NOT NULL DEFAULT false,
  estimated_monthly_cost_usd numeric(10,2),
  notes                      text,
  approved_by_user_id        uuid REFERENCES users(id),
  approval_changed_at        timestamptz DEFAULT now(),
  created_at                 timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_paid_source_approvals_account_source
  ON paid_source_approvals (account_id, source_name);
CREATE INDEX IF NOT EXISTS idx_paid_source_approvals_account
  ON paid_source_approvals (account_id);

CREATE TABLE IF NOT EXISTS paid_source_call_log (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL,
  user_id         uuid,
  source_name     text NOT NULL,
  source_category text NOT NULL,
  tool_name       text NOT NULL,
  request_args    jsonb,
  response_status text NOT NULL,
  cost_usd        numeric(10,4) DEFAULT 0,
  latency_ms      integer,
  error_message   text,
  session_id      uuid,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paid_source_log_account_time
  ON paid_source_call_log (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_paid_source_log_source
  ON paid_source_call_log (source_name, created_at);

CREATE TABLE IF NOT EXISTS agent_usage_limits (
  account_id                       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  max_queries_per_user_per_day     integer NOT NULL DEFAULT 100,
  max_queries_per_account_per_day  integer NOT NULL DEFAULT 1000,
  max_anthropic_cost_per_day_usd   numeric(10,2) NOT NULL DEFAULT 50,
  max_anthropic_cost_per_month_usd numeric(10,2) NOT NULL DEFAULT 1000,
  hard_stop_at_limit               boolean NOT NULL DEFAULT true,
  max_sub_agent_calls_per_day      integer DEFAULT 200,
  max_sub_agent_calls_per_turn     integer DEFAULT 3,
  updated_by_user_id               uuid,
  updated_at                       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_usage_daily (
  account_id           uuid NOT NULL,
  user_id              uuid NOT NULL,
  day                  date NOT NULL,
  query_count          integer DEFAULT 0,
  anthropic_cost_usd   numeric(10,4) DEFAULT 0,
  paid_source_cost_usd numeric(10,4) DEFAULT 0,
  total_cost_usd       numeric(10,4) DEFAULT 0,
  sub_agent_call_count integer DEFAULT 0,
  sub_agent_cost_usd   numeric(10,4) DEFAULT 0,
  PRIMARY KEY (account_id, day, user_id)
);

-- ─── Sub-agent registry ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sub_agent_registry (
  agent_name             text PRIMARY KEY,
  source_repo            text NOT NULL,
  source_commit          text,
  source_path            text NOT NULL,
  display_name           text NOT NULL,
  description            text NOT NULL,
  category               text NOT NULL,
  tier                   text NOT NULL DEFAULT 'B',
  emoji                  text,
  vibe                   text,
  persona_token_estimate integer,
  recommended_model      text DEFAULT 'claude-sonnet-4-6',
  enabled                boolean NOT NULL DEFAULT true,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  CONSTRAINT sub_agent_tier_chk CHECK (tier IN ('A','B'))
);
CREATE INDEX IF NOT EXISTS idx_sub_agent_tier     ON sub_agent_registry (tier, enabled);
CREATE INDEX IF NOT EXISTS idx_sub_agent_category ON sub_agent_registry (category);

CREATE TABLE IF NOT EXISTS sub_agent_invocations (
  id              bigserial PRIMARY KEY,
  session_id      uuid,
  account_id      uuid NOT NULL,
  user_id         uuid,
  agent_name      text NOT NULL REFERENCES sub_agent_registry(agent_name),
  question        text NOT NULL,
  context_summary text,
  response_text   text,
  response_tokens integer,
  request_tokens  integer,
  model_used      text,
  cost_usd        numeric(10,4) DEFAULT 0,
  latency_ms      integer,
  status          text NOT NULL DEFAULT 'pending',
  error_message   text,
  invoked_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_agent_invocations_account_time
  ON sub_agent_invocations (account_id, invoked_at);
CREATE INDEX IF NOT EXISTS idx_sub_agent_invocations_agent_time
  ON sub_agent_invocations (agent_name, invoked_at);

-- ─── User role audit ────────────────────────────────────────────────────────
-- users.role already exists as TEXT in the v1.0 schema — left as-is.

CREATE TABLE IF NOT EXISTS user_role_changes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES users(id),
  old_role   text,
  new_role   text NOT NULL,
  reason     text,
  changed_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_role_changes_user
  ON user_role_changes (user_id, changed_at);
