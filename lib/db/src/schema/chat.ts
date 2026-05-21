/**
 * v2.0 Chat-First layer — schema for the ProspectingAgent.
 *
 * Adapted from the handoff's raw migrations 014–017. Two deliberate
 * deviations from the handoff SQL, both forced by the actual v1.0 schema:
 *
 *  1. `chat_session_prospects.opportunity_id` is UUID, not BIGINT — the
 *     repo's `opportunities.id` is a uuid (handoff assumed bigserial).
 *  2. Paid-source gating uses a NEW `paid_source_approvals` table rather
 *     than extending `enrichment_source_approvals`. The v1.0 table is
 *     global (one row per source, `source` is a unique enum); the v2.0
 *     gate needs per-account×source rows. Retrofitting the v1.0 table
 *     would break the existing enrichment flow, so v2.0 gets its own.
 *
 * RLS policies are NOT defined here (Drizzle push doesn't manage them) —
 * see lib/db/src/scripts/v2a_chat_layer.sql, applied by v2_install.sh.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { accounts, users } from "./tenant";
import { opportunities } from "./opportunity";

// ─── Chat sessions (Migration 014) ──────────────────────────────────────────

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).defaultNow(),
    status: text("status").notNull().default("active"),
    contextSummary: text("context_summary"),
    totalTokensIn: bigint("total_tokens_in", { mode: "number" }).default(0),
    totalTokensOut: bigint("total_tokens_out", { mode: "number" }).default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 4 }).default("0"),
  },
  (t) => [
    index("idx_chat_sessions_account_user").on(t.accountId, t.userId, t.lastMessageAt),
    index("idx_chat_sessions_active").on(t.accountId, t.status),
  ],
);
export type ChatSession = typeof chatSessions.$inferSelect;

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    toolCalls: jsonb("tool_calls"),
    toolResults: jsonb("tool_results"),
    tokenUsage: jsonb("token_usage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_chat_messages_session").on(t.sessionId, t.createdAt),
    check("chat_messages_role_chk", sql`${t.role} IN ('user','assistant','tool','system')`),
  ],
);
export type ChatMessage = typeof chatMessages.$inferSelect;

export const chatSessionProspects = pgTable(
  "chat_session_prospects",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    // handoff said BIGINT; repo's opportunities.id is uuid.
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    surfacedAt: timestamp("surfaced_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.opportunityId] }),
    index("idx_chat_session_prospects_opp").on(t.opportunityId),
  ],
);
export type ChatSessionProspect = typeof chatSessionProspects.$inferSelect;

export const chatCostDaily = pgTable(
  "chat_cost_daily",
  {
    accountId: uuid("account_id").notNull(),
    day: date("day").notNull(),
    // In the handoff PK; Postgres forces PK columns NOT NULL.
    userId: uuid("user_id").notNull(),
    totalTokensIn: bigint("total_tokens_in", { mode: "number" }).default(0),
    totalTokensOut: bigint("total_tokens_out", { mode: "number" }).default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 4 }).default("0"),
    messageCount: integer("message_count").default(0),
    sessionCount: integer("session_count").default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day, t.userId] })],
);
export type ChatCostDaily = typeof chatCostDaily.$inferSelect;

// ─── Paid-source gating (Migration 015, adapted) ────────────────────────────

/**
 * Per-account × per-source approval row. The v2.0 paid-source dual gate:
 * this DB row (tenant switch) AND the matching `*_ENABLED` env var
 * (operator switch) must BOTH be true for a source to be callable.
 */
export const paidSourceApprovals = pgTable(
  "paid_source_approvals",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sourceName: text("source_name").notNull(),
    sourceCategory: text("source_category").notNull(),
    sourceTier: text("source_tier").default("paid"),
    approved: boolean("approved").notNull().default(false),
    estimatedMonthlyCostUsd: numeric("estimated_monthly_cost_usd", {
      precision: 10,
      scale: 2,
    }),
    notes: text("notes"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvalChangedAt: timestamp("approval_changed_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_paid_source_approvals_account_source").on(t.accountId, t.sourceName),
    index("idx_paid_source_approvals_account").on(t.accountId),
  ],
);
export type PaidSourceApproval = typeof paidSourceApprovals.$inferSelect;

export const paidSourceCallLog = pgTable(
  "paid_source_call_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id").notNull(),
    userId: uuid("user_id"),
    sourceName: text("source_name").notNull(),
    sourceCategory: text("source_category").notNull(),
    toolName: text("tool_name").notNull(),
    requestArgs: jsonb("request_args"),
    responseStatus: text("response_status").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).default("0"),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
    sessionId: uuid("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_paid_source_log_account_time").on(t.accountId, t.createdAt),
    index("idx_paid_source_log_source").on(t.sourceName, t.createdAt),
  ],
);
export type PaidSourceCallLog = typeof paidSourceCallLog.$inferSelect;

export const agentUsageLimits = pgTable("agent_usage_limits", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  maxQueriesPerUserPerDay: integer("max_queries_per_user_per_day").notNull().default(100),
  maxQueriesPerAccountPerDay: integer("max_queries_per_account_per_day").notNull().default(1000),
  maxAnthropicCostPerDayUsd: numeric("max_anthropic_cost_per_day_usd", {
    precision: 10,
    scale: 2,
  })
    .notNull()
    .default("50"),
  maxAnthropicCostPerMonthUsd: numeric("max_anthropic_cost_per_month_usd", {
    precision: 10,
    scale: 2,
  })
    .notNull()
    .default("1000"),
  hardStopAtLimit: boolean("hard_stop_at_limit").notNull().default(true),
  maxSubAgentCallsPerDay: integer("max_sub_agent_calls_per_day").default(200),
  maxSubAgentCallsPerTurn: integer("max_sub_agent_calls_per_turn").default(3),
  updatedByUserId: uuid("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
export type AgentUsageLimits = typeof agentUsageLimits.$inferSelect;

export const agentUsageDaily = pgTable(
  "agent_usage_daily",
  {
    accountId: uuid("account_id").notNull(),
    userId: uuid("user_id").notNull(),
    day: date("day").notNull(),
    queryCount: integer("query_count").default(0),
    anthropicCostUsd: numeric("anthropic_cost_usd", { precision: 10, scale: 4 }).default("0"),
    paidSourceCostUsd: numeric("paid_source_cost_usd", { precision: 10, scale: 4 }).default("0"),
    totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 4 }).default("0"),
    subAgentCallCount: integer("sub_agent_call_count").default(0),
    subAgentCostUsd: numeric("sub_agent_cost_usd", { precision: 10, scale: 4 }).default("0"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day, t.userId] })],
);
export type AgentUsageDaily = typeof agentUsageDaily.$inferSelect;

// ─── Sub-agent registry (Migration 016) ─────────────────────────────────────

export const subAgentRegistry = pgTable(
  "sub_agent_registry",
  {
    agentName: text("agent_name").primaryKey(),
    sourceRepo: text("source_repo").notNull(),
    sourceCommit: text("source_commit"),
    sourcePath: text("source_path").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    tier: text("tier").notNull().default("B"),
    emoji: text("emoji"),
    vibe: text("vibe"),
    personaTokenEstimate: integer("persona_token_estimate"),
    recommendedModel: text("recommended_model").default("claude-sonnet-4-6"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_sub_agent_tier").on(t.tier, t.enabled),
    index("idx_sub_agent_category").on(t.category),
    check("sub_agent_tier_chk", sql`${t.tier} IN ('A','B')`),
  ],
);
export type SubAgentRegistryRow = typeof subAgentRegistry.$inferSelect;

export const subAgentInvocations = pgTable(
  "sub_agent_invocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id"),
    accountId: uuid("account_id").notNull(),
    userId: uuid("user_id"),
    agentName: text("agent_name")
      .notNull()
      .references(() => subAgentRegistry.agentName),
    question: text("question").notNull(),
    contextSummary: text("context_summary"),
    responseText: text("response_text"),
    responseTokens: integer("response_tokens"),
    requestTokens: integer("request_tokens"),
    modelUsed: text("model_used"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).default("0"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    invokedAt: timestamp("invoked_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_sub_agent_invocations_account_time").on(t.accountId, t.invokedAt),
    index("idx_sub_agent_invocations_agent_time").on(t.agentName, t.invokedAt),
  ],
);
export type SubAgentInvocation = typeof subAgentInvocations.$inferSelect;

// ─── User role audit (Migration 017, adapted) ───────────────────────────────
// `users.role` already exists as TEXT in the v1.0 schema — kept as-is rather
// than converted to a Postgres enum (a destructive column-type change). The
// requireRole middleware validates the three allowed values at the app layer.

export const userRoleChanges = pgTable(
  "user_role_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    changedBy: uuid("changed_by")
      .notNull()
      .references(() => users.id),
    oldRole: text("old_role"),
    newRole: text("new_role").notNull(),
    reason: text("reason"),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_user_role_changes_user").on(t.userId, t.changedAt)],
);
export type UserRoleChange = typeof userRoleChanges.$inferSelect;

// ─── MCP result cache ───────────────────────────────────────────────────────
//
// Durable, cross-process cache for healthcare-data-mcp gateway tool calls.
// McpLiveGatewayClient previously cached results only in an in-process Map, so
// every MCP tool result was lost on restart and was never queryable. This
// table persists every gateway call keyed by (tool_name, args_hash) with its
// category TTL, latency, and full argument set, so MCP-sourced data actually
// accumulates in the database instead of evaporating between sessions.

export const mcpResultCache = pgTable(
  "mcp_result_cache",
  {
    id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
    /** MCP tool name, e.g. "cms-facility.get_facility". */
    toolName: text("tool_name").notNull(),
    /** TTL bucket: claims | quality | finance | news | facility | default. */
    category: text("category").notNull(),
    /** SHA-256 of the canonicalised argument object — the cache key beside tool_name. */
    argsHash: text("args_hash").notNull(),
    /** Raw arguments the tool was invoked with, kept for audit and queryability. */
    args: jsonb("args").notNull(),
    /** Tool result payload (already size-capped by the gateway client). */
    result: jsonb("result").notNull(),
    /** True when the gateway client truncated an oversized result to a shape summary. */
    truncated: boolean("truncated").notNull().default(false),
    /** Gateway round-trip latency of the originating live call, in milliseconds. */
    latencyMs: integer("latency_ms"),
    /** Times this row has been served from cache — best-effort read telemetry. */
    hitCount: integer("hit_count").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // The cache key: one row per (tool, args). Upserts target this index.
    uniqueIndex("uniq_mcp_result_cache_key").on(t.toolName, t.argsHash),
    // Freshness scans and the expired-row purge.
    index("idx_mcp_result_cache_expires").on(t.expiresAt),
    // Per-tool coverage queries ("how much of tool X have we stored").
    index("idx_mcp_result_cache_tool").on(t.toolName),
  ],
);
export type McpResultCacheRow = typeof mcpResultCache.$inferSelect;
