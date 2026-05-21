/**
 * Tests for PaidSourceGate (PR B) — the dual-gate paid-source chokepoint.
 * Covers all three gate states + the approval cache + audit logging.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, paidSourceApprovals, paidSourceCallLog } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { PaidSourceGate } from "../src/services/agent/paidSourceGate";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

let world: SeededWorld;
let accountId: string;

beforeAll(async () => {
  world = await seedWorld();
  accountId = world.tenantA.accountId;
  await db.insert(paidSourceApprovals).values([
    { accountId, sourceName: "proxycurl", sourceCategory: "open_informatics_mcp", approved: false },
    { accountId, sourceName: "newsapi", sourceCategory: "open_informatics_mcp", approved: false },
    { accountId, sourceName: "adzuna", sourceCategory: "medintel_proprietary", approved: true },
  ]);
});

afterAll(async () => {
  await db.delete(paidSourceCallLog).where(eq(paidSourceCallLog.accountId, accountId));
  await db.delete(paidSourceApprovals).where(eq(paidSourceApprovals.accountId, accountId));
  if (world) await teardownWorld(world);
});

describe("PaidSourceGate.check — dual gate", () => {
  it("denied_env when the system env switch is off", async () => {
    const gate = new PaidSourceGate({} as NodeJS.ProcessEnv);
    const r = await gate.check({ sourceName: "proxycurl", accountId });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("denied_env");
    expect(r.userMessage).toContain("PROXYCURL_ENABLED");
  });

  it("denied_approval when env is on but the tenant hasn't approved", async () => {
    const gate = new PaidSourceGate({ PROXYCURL_ENABLED: "true" } as NodeJS.ProcessEnv);
    const r = await gate.check({ sourceName: "proxycurl", accountId });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("denied_approval");
  });

  it("allowed when env is on AND the tenant has approved", async () => {
    const gate = new PaidSourceGate({ ADZUNA_ENABLED: "true" } as NodeJS.ProcessEnv);
    const r = await gate.check({ sourceName: "adzuna", accountId });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("env literal must be exactly 'true' for boolean-gated sources", async () => {
    const gate = new PaidSourceGate({ ADZUNA_ENABLED: "1" } as NodeJS.ProcessEnv);
    const r = await gate.check({ sourceName: "adzuna", accountId });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("denied_env");
  });

  it("setApproval flips the gate and invalidates the cache", async () => {
    const gate = new PaidSourceGate({ NEWSAPI_ENABLED: "true" } as NodeJS.ProcessEnv);

    // Initially denied (seeded approved=false) — also primes the cache.
    expect((await gate.check({ sourceName: "newsapi", accountId })).reason).toBe("denied_approval");

    const { updated } = await gate.setApproval({
      accountId,
      sourceName: "newsapi",
      approved: true,
      userId: world.tenantA.userId,
    });
    expect(updated).toBe(true);

    // Next check sees the fresh value, not the stale cached deny.
    expect((await gate.check({ sourceName: "newsapi", accountId })).allowed).toBe(true);
  });

  it("logCall writes an audit row", async () => {
    const gate = new PaidSourceGate({} as NodeJS.ProcessEnv);
    const check = await gate.check({ sourceName: "proxycurl", accountId, toolName: "test_tool" });
    await gate.logCall({ ...check.audit, responseStatus: check.reason! });

    const rows = await db
      .select()
      .from(paidSourceCallLog)
      .where(
        and(
          eq(paidSourceCallLog.accountId, accountId),
          eq(paidSourceCallLog.toolName, "test_tool"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].responseStatus).toBe("denied_env");
  });

  it("listApprovals annotates each row with env + callable_now", async () => {
    const gate = new PaidSourceGate({ ADZUNA_ENABLED: "true" } as NodeJS.ProcessEnv);
    const list = await gate.listApprovals(accountId);
    const adzuna = list.find((r) => r.sourceName === "adzuna");
    expect(adzuna?.envEnabled).toBe(true);
    expect(adzuna?.callableNow).toBe(true);
    const proxycurl = list.find((r) => r.sourceName === "proxycurl");
    expect(proxycurl?.callableNow).toBe(false);
  });

  it("rejects a check with no accountId", async () => {
    const gate = new PaidSourceGate({} as NodeJS.ProcessEnv);
    await expect(gate.check({ sourceName: "proxycurl", accountId: "" })).rejects.toThrow();
  });
});
