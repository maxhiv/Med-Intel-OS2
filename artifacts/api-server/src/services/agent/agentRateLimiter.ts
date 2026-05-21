/**
 * AgentRateLimiter — per-user and per-account daily ceilings on
 * ProspectingAgent usage: query count + Anthropic cost (day + month).
 *
 * Adapted from the handoff's AgentRateLimiter.js to Drizzle. Limits live in
 * `agent_usage_limits` (per account, env-var fallback); counters live in
 * `agent_usage_daily`, incremented atomically per accepted query.
 *
 * `db` is RLS-scoped per request, so all reads/writes are account-isolated.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, agentUsageLimits, agentUsageDaily } from "@workspace/db";

export type RateLimitReason =
  | "user_daily_query_limit"
  | "account_daily_query_limit"
  | "account_daily_cost_limit"
  | "account_monthly_cost_limit";

export interface EffectiveLimits {
  perUserDay: number;
  perAccountDay: number;
  maxAnthropicCostPerDayUsd: number;
  maxAnthropicCostPerMonthUsd: number;
  hardStop: boolean;
}

export interface CurrentUsage {
  perUser: number;
  perAccount: number;
  anthropicCostUsd: number;
  anthropicCostMonthUsd: number;
}

export interface RateCheckResult {
  allowed: boolean;
  reason?: RateLimitReason;
  userMessage?: string;
  limits: EffectiveLimits;
  current: CurrentUsage;
}

const ENV_DEFAULTS = (env: NodeJS.ProcessEnv): EffectiveLimits => ({
  perUserDay: parseInt(env.AGENT_RATE_LIMIT_PER_USER_PER_DAY ?? "100", 10),
  perAccountDay: parseInt(env.AGENT_RATE_LIMIT_PER_ACCOUNT_PER_DAY ?? "1000", 10),
  maxAnthropicCostPerDayUsd: parseFloat(env.AGENT_MAX_ANTHROPIC_COST_PER_DAY_USD ?? "50"),
  maxAnthropicCostPerMonthUsd: parseFloat(env.AGENT_MAX_ANTHROPIC_COST_PER_MONTH_USD ?? "1000"),
  hardStop: env.AGENT_RATE_LIMIT_HARD_STOP !== "false",
});

export class AgentRateLimiter {
  private env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  /** Is a new agent query allowed for this user right now? */
  async check(input: { accountId: string; userId: string }): Promise<RateCheckResult> {
    const { accountId, userId } = input;
    if (!accountId) throw new Error("accountId is required");
    if (!userId) throw new Error("userId is required");

    const limits = await this.loadLimits(accountId);
    const current = await this.loadCurrent(accountId, userId);

    const deny = (reason: RateLimitReason, userMessage: string): RateCheckResult => ({
      // hard-stop accounts are blocked; soft accounts get a warning but proceed
      allowed: !limits.hardStop,
      reason,
      userMessage,
      limits,
      current,
    });

    if (current.perUser >= limits.perUserDay) {
      return deny(
        "user_daily_query_limit",
        `You've reached your daily limit of ${limits.perUserDay} queries. It resets at midnight ${this.env.CRON_TIMEZONE ?? "America/Chicago"}.`,
      );
    }
    if (current.perAccount >= limits.perAccountDay) {
      return deny(
        "account_daily_query_limit",
        `Your account hit its daily limit of ${limits.perAccountDay} queries across all users.`,
      );
    }
    if (current.anthropicCostUsd >= limits.maxAnthropicCostPerDayUsd) {
      return deny(
        "account_daily_cost_limit",
        `Your account reached its daily Anthropic cost ceiling of $${limits.maxAnthropicCostPerDayUsd}.`,
      );
    }
    if (current.anthropicCostMonthUsd >= limits.maxAnthropicCostPerMonthUsd) {
      return deny(
        "account_monthly_cost_limit",
        `Your account reached its monthly Anthropic cost ceiling of $${limits.maxAnthropicCostPerMonthUsd}.`,
      );
    }

    return { allowed: true, limits, current };
  }

  /** Atomically bump today's counters for an accepted query. */
  async recordQuery(input: {
    accountId: string;
    userId: string;
    anthropicCostUsd?: number;
    paidSourceCostUsd?: number;
  }): Promise<void> {
    const anthropic = input.anthropicCostUsd ?? 0;
    const paid = input.paidSourceCostUsd ?? 0;
    const total = anthropic + paid;
    const today = new Date().toISOString().slice(0, 10);

    await db
      .insert(agentUsageDaily)
      .values({
        accountId: input.accountId,
        userId: input.userId,
        day: today,
        queryCount: 1,
        anthropicCostUsd: String(anthropic),
        paidSourceCostUsd: String(paid),
        totalCostUsd: String(total),
      })
      .onConflictDoUpdate({
        target: [agentUsageDaily.accountId, agentUsageDaily.day, agentUsageDaily.userId],
        set: {
          queryCount: sql`${agentUsageDaily.queryCount} + 1`,
          anthropicCostUsd: sql`${agentUsageDaily.anthropicCostUsd} + ${anthropic}`,
          paidSourceCostUsd: sql`${agentUsageDaily.paidSourceCostUsd} + ${paid}`,
          totalCostUsd: sql`${agentUsageDaily.totalCostUsd} + ${total}`,
        },
      });
  }

  async loadLimits(accountId: string): Promise<EffectiveLimits> {
    const [row] = await db
      .select()
      .from(agentUsageLimits)
      .where(eq(agentUsageLimits.accountId, accountId))
      .limit(1);
    if (!row) return ENV_DEFAULTS(this.env);
    return {
      perUserDay: row.maxQueriesPerUserPerDay,
      perAccountDay: row.maxQueriesPerAccountPerDay,
      maxAnthropicCostPerDayUsd: parseFloat(row.maxAnthropicCostPerDayUsd),
      maxAnthropicCostPerMonthUsd: parseFloat(row.maxAnthropicCostPerMonthUsd),
      hardStop: row.hardStopAtLimit,
    };
  }

  private async loadCurrent(accountId: string, userId: string): Promise<CurrentUsage> {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";

    const [userRow] = await db
      .select({ queryCount: agentUsageDaily.queryCount })
      .from(agentUsageDaily)
      .where(
        and(
          eq(agentUsageDaily.accountId, accountId),
          eq(agentUsageDaily.userId, userId),
          eq(agentUsageDaily.day, today),
        ),
      )
      .limit(1);

    const [acctDay] = await db
      .select({
        queryCount: sql<number>`COALESCE(SUM(${agentUsageDaily.queryCount}), 0)::int`,
        cost: sql<string>`COALESCE(SUM(${agentUsageDaily.anthropicCostUsd}), 0)::text`,
      })
      .from(agentUsageDaily)
      .where(and(eq(agentUsageDaily.accountId, accountId), eq(agentUsageDaily.day, today)));

    const [acctMonth] = await db
      .select({
        cost: sql<string>`COALESCE(SUM(${agentUsageDaily.anthropicCostUsd}), 0)::text`,
      })
      .from(agentUsageDaily)
      .where(
        and(
          eq(agentUsageDaily.accountId, accountId),
          sql`${agentUsageDaily.day} >= ${monthStart}`,
        ),
      );

    return {
      perUser: userRow?.queryCount ?? 0,
      perAccount: acctDay?.queryCount ?? 0,
      anthropicCostUsd: parseFloat(acctDay?.cost ?? "0"),
      anthropicCostMonthUsd: parseFloat(acctMonth?.cost ?? "0"),
    };
  }
}

export const agentRateLimiter = new AgentRateLimiter();
