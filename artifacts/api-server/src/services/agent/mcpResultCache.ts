/**
 * Durable persistence layer for healthcare-data-mcp gateway tool results.
 *
 * McpLiveGatewayClient uses this as the L2 cache behind its in-process Map:
 * every gateway call is written here keyed by (toolName, argsHash), so MCP
 * tool data survives restarts, is shared across processes, and is queryable
 * for coverage and audit.
 *
 * Every function is fail-soft — a database problem must never break an agent
 * tool call. Reads return `null` on any error (the caller falls through to a
 * live gateway call); writes swallow errors after logging.
 */
import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, mcpResultCache } from "@workspace/db";
import { logger } from "../../lib/logger";

export interface McpCacheHit {
  value: Record<string, unknown>;
  expiresAt: number;
}

export interface McpCacheWrite {
  toolName: string;
  category: string;
  argsHash: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  truncated: boolean;
  latencyMs: number;
  expiresAt: Date;
}

/** Deterministic, key-order-independent JSON encoding for hashing tool args. */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj) ?? "null";
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const rec = obj as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(",")}}`;
}

/** SHA-256 of the canonicalised tool arguments — the cache key beside toolName. */
export function hashMcpArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

/** Look up a fresh (non-expired) cached result. Null on miss, expiry, or DB error. */
export async function readMcpResultCache(
  toolName: string,
  argsHash: string,
): Promise<McpCacheHit | null> {
  try {
    const [row] = await db
      .select()
      .from(mcpResultCache)
      .where(and(eq(mcpResultCache.toolName, toolName), eq(mcpResultCache.argsHash, argsHash)))
      .limit(1);
    if (!row) return null;

    const expiresAt = row.expiresAt.getTime();
    if (expiresAt <= Date.now()) return null;

    // Read telemetry — never let it fail the lookup.
    try {
      await db
        .update(mcpResultCache)
        .set({ hitCount: row.hitCount + 1, lastAccessedAt: new Date() })
        .where(eq(mcpResultCache.id, row.id));
    } catch {
      /* telemetry only */
    }

    return {
      value: {
        ...(row.result as Record<string, unknown>),
        _latencyMs: row.latencyMs ?? undefined,
      },
      expiresAt,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), toolName },
      "mcp result cache read failed; falling through to live gateway call",
    );
    return null;
  }
}

/** Upsert a result into the durable cache. Swallows errors after logging. */
export async function writeMcpResultCache(e: McpCacheWrite): Promise<void> {
  try {
    await db
      .insert(mcpResultCache)
      .values({
        toolName: e.toolName,
        category: e.category,
        argsHash: e.argsHash,
        args: e.args,
        result: e.result,
        truncated: e.truncated,
        latencyMs: e.latencyMs,
        hitCount: 0,
        fetchedAt: new Date(),
        expiresAt: e.expiresAt,
      })
      .onConflictDoUpdate({
        target: [mcpResultCache.toolName, mcpResultCache.argsHash],
        set: {
          category: e.category,
          args: e.args,
          result: e.result,
          truncated: e.truncated,
          latencyMs: e.latencyMs,
          hitCount: 0,
          fetchedAt: new Date(),
          lastAccessedAt: null,
          expiresAt: e.expiresAt,
        },
      });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), toolName: e.toolName },
      "mcp result cache write failed; result served live but not persisted",
    );
  }
}

/** Delete cache rows that expired more than `olderThanDays` ago. Returns rows removed. */
export async function purgeMcpResultCache(olderThanDays = 30): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600_000);
    const deleted = await db
      .delete(mcpResultCache)
      .where(lt(mcpResultCache.expiresAt, cutoff))
      .returning({ id: mcpResultCache.id });
    return deleted.length;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "mcp result cache purge failed",
    );
    return 0;
  }
}
