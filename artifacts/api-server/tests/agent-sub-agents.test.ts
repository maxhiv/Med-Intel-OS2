/**
 * Tests for the sub-agent layer (PR E) — SubAgentInvoker + subAgentTools,
 * with a stubbed Anthropic client. The persona markdown is read from the
 * real vendor/sub-agents/ directory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: createMock } },
}));

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, subAgentRegistry, subAgentInvocations } from "@workspace/db";
import { subAgentInvoker } from "../src/services/agent/subAgentInvoker";
import { buildSubAgentTools, consultToolName } from "../src/services/agent/tools/subAgentTools";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

let world: SeededWorld;

// A registry row pointing at a real vendored persona file. onConflictDoNothing
// keeps the production seed row if v2a_seed_sub_agents.sql already applied it.
const TEST_AGENT = "revenue-finance-manager";

beforeAll(async () => {
  world = await seedWorld();
  await db
    .insert(subAgentRegistry)
    .values({
      agentName: TEST_AGENT,
      sourceRepo: "healthcare-agents",
      sourcePath: "revenue-finance-manager.md",
      displayName: "Revenue Cycle Finance Manager",
      description: "Financial-readiness authority for hospital capital purchases.",
      category: "revenue",
      tier: "A",
      emoji: "💰",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(subAgentInvocations)
    .where(eq(subAgentInvocations.accountId, world.tenantA.accountId));
  if (world) await teardownWorld(world);
});

function consultResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 900, output_tokens: 220 },
  };
}

describe("SubAgentInvoker", () => {
  it("consult() runs a persona one-shot and logs the invocation", async () => {
    createMock.mockResolvedValueOnce(
      consultResponse("Days cash on hand above 150 signals capital headroom."),
    );

    const result = await subAgentInvoker.consult({
      agentName: TEST_AGENT,
      context: "Facility: 200-bed community hospital, 8% operating margin.",
      question: "Can this facility absorb a $1.5M capital purchase?",
      accountId: world.tenantA.accountId,
      userId: world.tenantA.userId,
    });

    expect(result.status).toBe("success");
    expect(result.response).toContain("Days cash on hand");
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.displayName).toBe("Revenue Cycle Finance Manager");

    // The persona body — not the YAML frontmatter — reaches the model.
    const call = createMock.mock.calls[0][0];
    expect(String(call.system)).toContain("Revenue Cycle Finance Manager");
    expect(String(call.system)).not.toMatch(/^---\nname:/);

    const [logged] = await db
      .select()
      .from(subAgentInvocations)
      .where(
        and(
          eq(subAgentInvocations.accountId, world.tenantA.accountId),
          eq(subAgentInvocations.agentName, TEST_AGENT),
        ),
      )
      .limit(1);
    expect(logged).toBeTruthy();
    expect(logged.status).toBe("success");
  });

  it("consult() on an unregistered agent fails soft (no throw)", async () => {
    const result = await subAgentInvoker.consult({
      agentName: "no-such-specialist",
      question: "anything",
      accountId: world.tenantA.accountId,
    });
    expect(result.status).toBe("disabled");
    expect(result.response).toContain("no-such-specialist");
  });

  it("listTierA() includes the seeded specialist", async () => {
    const roster = await subAgentInvoker.listTierA();
    expect(roster.some((r) => r.agentName === TEST_AGENT)).toBe(true);
  });
});

describe("buildSubAgentTools", () => {
  it("emits a consult_<name> tool that routes through the invoker", async () => {
    const reg = await buildSubAgentTools({
      accountId: world.tenantA.accountId,
      userId: world.tenantA.userId,
      sessionId: randomUUID(),
    });

    const toolName = consultToolName(TEST_AGENT);
    expect(reg.definitions.some((d) => d.name === toolName)).toBe(true);

    createMock.mockResolvedValueOnce(consultViaTool());
    const exec = reg.executors.get(toolName)!;
    const r = await exec({ question: "Is the financing structured well?" });

    expect(r.subAgent).toBeTruthy();
    expect(r.subAgent!.agentName).toBe(TEST_AGENT);
    expect(typeof r.costUsd).toBe("number");
    expect((r.content as { response: string }).response).toContain("lease");
  });
});

function consultViaTool() {
  return {
    content: [{ type: "text", text: "An operating lease keeps it off the balance sheet." }],
    usage: { input_tokens: 700, output_tokens: 150 },
  };
}
