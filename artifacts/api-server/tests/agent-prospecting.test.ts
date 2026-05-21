/**
 * Tests for the ProspectingAgent core (PR C) — happy path + tool loop,
 * with a stubbed Anthropic client. Also covers the tool-registry builders.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Stub the Anthropic client BEFORE importing anything that pulls it in.
// vi.hoisted runs before the hoisted vi.mock factory, so createMock exists.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: createMock } },
}));

import { eq } from "drizzle-orm";
import { db, chatSessions, chatMessages } from "@workspace/db";
import { ProspectingAgent } from "../src/services/agent/prospectingAgent";
import { buildMedIntelTools } from "../src/services/agent/tools/medintelTools";
import { buildDatabaseAndActionTools } from "../src/services/agent/tools/databaseAndActionTools";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

let world: SeededWorld;
let sessionId: string;

beforeAll(async () => {
  world = await seedWorld();
  const [s] = await db
    .insert(chatSessions)
    .values({ accountId: world.tenantA.accountId, userId: world.tenantA.userId, title: "test" })
    .returning({ id: chatSessions.id });
  sessionId = s.id;
});

afterAll(async () => {
  await db.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId));
  await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
  if (world) await teardownWorld(world);
});

function textMessage(text: string) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
  };
}

describe("tool-registry builders", () => {
  it("buildMedIntelTools ships 9 proprietary stubs that return not_implemented", async () => {
    const reg = buildMedIntelTools();
    expect(reg.definitions.length).toBe(9);
    const exec = reg.executors.get("medintel_search_con_filings")!;
    const r = await exec({ state: "TX" });
    expect((r.content as { status: string }).status).toBe("not_implemented");
  });

  it("buildDatabaseAndActionTools ships the read + action tools", () => {
    const reg = buildDatabaseAndActionTools({
      accountId: "a",
      userId: "u",
      sessionId: "s",
    });
    const names = reg.definitions.map((d) => d.name);
    expect(names).toContain("db_query_facilities");
    expect(names).toContain("db_persist_opportunity");
    expect(names).toContain("draft_outreach");
    expect(names).toContain("request_clarification");
  });
});

describe("ProspectingAgent", () => {
  it("happy path — a plain text turn persists user + assistant messages", async () => {
    createMock.mockResolvedValueOnce(textMessage("Here are three Texas imaging centers."));

    const agent = new ProspectingAgent({
      accountId: world.tenantA.accountId,
      userId: world.tenantA.userId,
      sessionId,
    });
    const tokens: string[] = [];
    const result = await agent.sendMessage("find imaging centers in TX", {
      onToken: (t) => tokens.push(t),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toBe(0);
    expect(result.inputTokens).toBe(1200);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(tokens.join("")).toContain("Texas imaging centers");

    const rows = await db
      .select({ role: chatMessages.role })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    expect(rows.filter((r) => r.role === "user").length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.role === "assistant").length).toBeGreaterThanOrEqual(1);
  });

  it("tool loop — executes a tool call then finishes on end_turn", async () => {
    // Turn 1: model asks for a tool. Turn 2: model finishes.
    createMock
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me search." },
          { type: "tool_use", id: "tu_1", name: "db_query_facilities", input: { state: "TX", limit: 3 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 0 },
      })
      .mockResolvedValueOnce(textMessage("Found them."));

    const agent = new ProspectingAgent({
      accountId: world.tenantA.accountId,
      userId: world.tenantA.userId,
      sessionId,
    });
    const toolCalls: string[] = [];
    const result = await agent.sendMessage("search TX", {
      onToolCall: (e) => toolCalls.push(e.tool),
    });

    expect(toolCalls).toContain("db_query_facilities");
    expect(result.toolCalls).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    // create() called twice — once for the tool turn, once to finish.
    expect(createMock).toHaveBeenCalledTimes(3); // 1 (happy-path test) + 2 here
  });
});
