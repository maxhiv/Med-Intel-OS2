-- v2c_mcp_cache.sql — durable cache for healthcare-data-mcp gateway tool calls.
--
-- McpLiveGatewayClient cached gateway results only in an in-process Map: every
-- MCP tool result was lost on restart and was never queryable. This table
-- persists every gateway call keyed by (tool_name, args_hash) so MCP-sourced
-- data accumulates in the database with full provenance — arguments, latency,
-- category TTL, and access counts.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS mcp_result_cache (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_name        text        NOT NULL,
  category         text        NOT NULL,
  args_hash        text        NOT NULL,
  args             jsonb       NOT NULL,
  result           jsonb       NOT NULL,
  truncated        boolean     NOT NULL DEFAULT false,
  latency_ms       integer,
  hit_count        integer     NOT NULL DEFAULT 0,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  expires_at       timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mcp_result_cache_key
  ON mcp_result_cache (tool_name, args_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_result_cache_expires
  ON mcp_result_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_result_cache_tool
  ON mcp_result_cache (tool_name);
