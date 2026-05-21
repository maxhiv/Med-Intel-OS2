/**
 * Tests for AgentRateLimiter (PR B) — per-user / per-account daily ceilings.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, agentUsageLimits, agentUsageDaily } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AgentRateLimiter } from "../src/services/agent/agentRateLimiter";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

let world: SeededWorld;
let accountId: string;
let userId: string;

beforeAll(async () => {
  world = await seedWorld();
  accountId = world.tenantA.accountId;
  userId = world.tenantA.userId;
});

afterAll(async () => {
  await db.delete(agentUsageDaily).where(eq(agentUsageDaily.accountId, accountId));
  await db.delete(agentUsageLimits).where(eq(agentUsageLimits.accountId, accountId));
  if (world) await teardownWorld(world);
});

describe("AgentRateLimiter", () => {
  it("allows a query when no usage row exists yet", async () => {
    const rl = new AgentRateLimiter({} as NodeJS.ProcessEnv);
    const r = await rl.check({ accountId, userId });
    expect(r.allowed).toBe(true);
    expect(r.current.perUser).toBe(0);
  });

  it("recordQuery increments today's per-user counter", async () => {
    const rl = new AgentRateLimiter({} as NodeJS.ProcessEnv);
    await rl.recordQuery({ accountId, userId, anthropicCostUsd: 0.17 });
    await rl.recordQuery({ accountId, userId, anthropicCostUsd: 0.17 });
    const r = await rl.check({ accountId, userId });
    expect(r.current.perUser).toBe(2);
    expect(r.current.anthropicCostUsd).toBeCloseTo(0.34, 2);
  });

  it("denies once the per-user daily query limit is hit (hard stop)", async () => {
    // Tighten the limit to 2/day for this account.
    await db
      .insert(agentUsageLimits)
      .values({ accountId, maxQueriesPerUserPerDay: 2, hardStopAtLimit: true })
      .onConflictDoUpdate({
        target: agentUsageLimits.accountId,
        set: { maxQueriesPerUserPerDay: 2, hardStopAtLimit: true },
      });
    // The previous test already recorded 2 queries → at the ceiling.
    const r = await new AgentRateLimiter({} as NodeJS.ProcessEnv).check({ accountId, userId });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("user_daily_query_limit");
    expect(r.userMessage).toContain("daily limit");
  });

  it("soft-limit accounts (hard_stop=false) are allowed past the ceiling with a warning", async () => {
    await db
      .update(agentUsageLimits)
      .set({ hardStopAtLimit: false })
      .where(eq(agentUsageLimits.accountId, accountId));
    const r = await new AgentRateLimiter({} as NodeJS.ProcessEnv).check({ accountId, userId });
    expect(r.allowed).toBe(true); // not hard-stopped
    expect(r.reason).toBe("user_daily_query_limit"); // still flagged
  });

  it("denies on the daily Anthropic cost ceiling", async () => {
    await db
      .update(agentUsageLimits)
      .set({
        maxQueriesPerUserPerDay: 1000,
        maxAnthropicCostPerDayUsd: "0.10",
        hardStopAtLimit: true,
      })
      .where(eq(agentUsageLimits.accountId, accountId));
    // 0.34 already recorded > 0.10 ceiling.
    const r = await new AgentRateLimiter({} as NodeJS.ProcessEnv).check({ accountId, userId });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("account_daily_cost_limit");
  });

  it("falls back to env defaults when no limits row exists", async () => {
    await db.delete(agentUsageLimits).where(eq(agentUsageLimits.accountId, accountId));
    const rl = new AgentRateLimiter({
      AGENT_RATE_LIMIT_PER_USER_PER_DAY: "5",
    } as NodeJS.ProcessEnv);
    const limits = await rl.loadLimits(accountId);
    expect(limits.perUserDay).toBe(5);
  });

  it("increments are atomic under concurrent recordQuery calls", async () => {
    await db.delete(agentUsageDaily).where(eq(agentUsageDaily.accountId, accountId));
    const rl = new AgentRateLimiter({} as NodeJS.ProcessEnv);
    await Promise.all(
      Array.from({ length: 10 }, () => rl.recordQuery({ accountId, userId })),
    );
    const r = await rl.check({ accountId, userId });
    expect(r.current.perUser).toBe(10);
  });
});
