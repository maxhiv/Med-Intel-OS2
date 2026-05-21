/**
 * Tests for the durable MCP result cache (PR: durable MCP result-cache).
 *
 * The cache is the L2 tier behind McpLiveGatewayClient's in-process Map — it
 * persists every healthcare-data-mcp gateway tool call to Postgres so MCP
 * data survives restarts and is queryable. These tests exercise the hash,
 * round-trip, expiry, upsert-refresh, and purge behaviour against the real DB.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, mcpResultCache } from "@workspace/db";
import {
  hashMcpArgs,
  readMcpResultCache,
  writeMcpResultCache,
  purgeMcpResultCache,
} from "../src/services/agent/mcpResultCache";

const tag = randomUUID().slice(0, 8);
const tool = (suffix: string) => `test.${tag}.${suffix}`;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

afterAll(async () => {
  await db.delete(mcpResultCache).where(like(mcpResultCache.toolName, `test.${tag}.%`));
});

describe("hashMcpArgs", () => {
  it("is independent of key order", () => {
    expect(hashMcpArgs({ a: 1, b: 2 })).toBe(hashMcpArgs({ b: 2, a: 1 }));
  });

  it("differs for different arguments", () => {
    expect(hashMcpArgs({ ccn: "111" })).not.toBe(hashMcpArgs({ ccn: "222" }));
  });

  it("canonicalises nested objects deterministically", () => {
    const a = hashMcpArgs({ outer: { y: 2, x: 1 }, list: [1, 2] });
    const b = hashMcpArgs({ list: [1, 2], outer: { x: 1, y: 2 } });
    expect(a).toBe(b);
  });
});

describe("writeMcpResultCache / readMcpResultCache", () => {
  it("round-trips a result and serves it as a cache hit", async () => {
    const toolName = tool("roundtrip");
    const argsHash = hashMcpArgs({ ccn: "340001" });
    await writeMcpResultCache({
      toolName,
      category: "facility",
      argsHash,
      args: { ccn: "340001" },
      result: { name: "Wilkes Medical Center", beds: 120 },
      truncated: false,
      latencyMs: 412,
      expiresAt: new Date(Date.now() + DAY),
    });

    const hit = await readMcpResultCache(toolName, argsHash);
    expect(hit).not.toBeNull();
    expect(hit?.value.name).toBe("Wilkes Medical Center");
    expect(hit?.value.beds).toBe(120);
    // Latency is restored from its column, not the result payload.
    expect(hit?.value._latencyMs).toBe(412);
  });

  it("returns null for an unknown key", async () => {
    expect(await readMcpResultCache(tool("missing"), hashMcpArgs({ x: 1 }))).toBeNull();
  });

  it("treats an expired row as a miss", async () => {
    const toolName = tool("expired");
    const argsHash = hashMcpArgs({ q: "stale" });
    await writeMcpResultCache({
      toolName,
      category: "news",
      argsHash,
      args: { q: "stale" },
      result: { items: [] },
      truncated: false,
      latencyMs: 10,
      expiresAt: new Date(Date.now() - HOUR),
    });
    expect(await readMcpResultCache(toolName, argsHash)).toBeNull();
  });

  it("increments hit_count on each read", async () => {
    const toolName = tool("hits");
    const argsHash = hashMcpArgs({ npi: "1234567890" });
    await writeMcpResultCache({
      toolName,
      category: "default",
      argsHash,
      args: { npi: "1234567890" },
      result: { ok: true },
      truncated: false,
      latencyMs: 5,
      expiresAt: new Date(Date.now() + DAY),
    });
    await readMcpResultCache(toolName, argsHash);
    await readMcpResultCache(toolName, argsHash);
    const [row] = await db
      .select()
      .from(mcpResultCache)
      .where(eq(mcpResultCache.toolName, toolName));
    expect(row.hitCount).toBe(2);
    expect(row.lastAccessedAt).not.toBeNull();
  });

  it("upserts: a second write to the same key replaces the result and resets hits", async () => {
    const toolName = tool("upsert");
    const argsHash = hashMcpArgs({ id: 1 });
    const base = {
      toolName,
      category: "facility" as const,
      argsHash,
      args: { id: 1 },
      truncated: false,
      latencyMs: 1,
      expiresAt: new Date(Date.now() + DAY),
    };
    await writeMcpResultCache({ ...base, result: { version: "old" } });
    await readMcpResultCache(toolName, argsHash); // hitCount -> 1
    await writeMcpResultCache({ ...base, result: { version: "new" } });

    const rows = await db
      .select()
      .from(mcpResultCache)
      .where(eq(mcpResultCache.toolName, toolName));
    expect(rows).toHaveLength(1); // unique (tool, args_hash) — no duplicate row
    expect(rows[0].result).toEqual({ version: "new" });
    expect(rows[0].hitCount).toBe(0); // reset by the refresh
  });
});

describe("purgeMcpResultCache", () => {
  it("deletes rows expired beyond the cutoff and keeps fresher ones", async () => {
    const oldTool = tool("purge-old");
    const keepTool = tool("purge-keep");
    await writeMcpResultCache({
      toolName: oldTool,
      category: "default",
      argsHash: hashMcpArgs({ k: "old" }),
      args: { k: "old" },
      result: { stale: true },
      truncated: false,
      latencyMs: 1,
      expiresAt: new Date(Date.now() - 40 * DAY),
    });
    await writeMcpResultCache({
      toolName: keepTool,
      category: "default",
      argsHash: hashMcpArgs({ k: "keep" }),
      args: { k: "keep" },
      result: { stale: false },
      truncated: false,
      latencyMs: 1,
      expiresAt: new Date(Date.now() - 2 * DAY),
    });

    await purgeMcpResultCache(30);

    const old = await db
      .select()
      .from(mcpResultCache)
      .where(eq(mcpResultCache.toolName, oldTool));
    const keep = await db
      .select()
      .from(mcpResultCache)
      .where(eq(mcpResultCache.toolName, keepTool));
    expect(old).toHaveLength(0); // expired 40 days ago — purged
    expect(keep).toHaveLength(1); // expired only 2 days ago — retained
  });
});
