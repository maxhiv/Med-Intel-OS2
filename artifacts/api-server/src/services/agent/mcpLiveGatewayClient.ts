/**
 * McpLiveGatewayClient — HTTP client for the Open-Informatics healthcare-data-mcp
 * live-gateway.
 *
 * Adapted from the handoff's McpLiveGatewayClient.js. The gateway is a separate
 * Python service (the handoff runs it as a Docker sidecar; on Replit it should
 * run as its own always-on Reserved-VM Repl). This client is deliberately
 * fail-soft: if `MCP_GATEWAY_URL` is unset or the gateway is unreachable, the
 * ProspectingAgent simply runs without the 138 MCP tools — it still has the
 * proprietary + database tools. The operator stands the gateway up later and
 * the agent picks the tools up on the next session with no code change.
 */
import { logger } from "../../lib/logger";

const DEFAULT_TIMEOUT_MS = 30_000;

const CATEGORY_TTL_MS: Record<string, number> = {
  claims: 30 * 24 * 3600_000,
  quality: 30 * 24 * 3600_000,
  finance: 7 * 24 * 3600_000,
  news: 3600_000,
  facility: 24 * 3600_000,
  default: 24 * 3600_000,
};

export interface McpToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  [key: string]: unknown;
  _cached?: boolean;
  _latencyMs?: number;
}

export class McpLiveGatewayClient {
  readonly configured: boolean;
  private baseUrl: string;
  private token: string;
  private timeoutMs: number;
  private maxResultBytes: number;
  private cache = new Map<string, { value: McpCallResult; expiresAt: number }>();

  constructor(
    opts: { baseUrl?: string; token?: string; timeoutMs?: number; maxResultKb?: number } = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? process.env.MCP_GATEWAY_URL ?? "").replace(/\/$/, "");
    this.token = opts.token ?? process.env.MCP_LIVE_GATEWAY_TOKEN ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResultBytes = (opts.maxResultKb ?? 64) * 1024;
    // The client is "configured" only when both a URL and a token are present.
    this.configured = Boolean(this.baseUrl && this.token);
  }

  /** Reachability + tool-count probe. Never throws — returns {ok:false} instead. */
  async health(): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    if (!this.configured) return { ok: false, error: "MCP gateway not configured" };
    try {
      const tools = await this.listTools();
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** List the gateway's tool catalog. Returns [] if not configured. */
  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.configured) return [];
    const resp = (await this.request("/tools/list", {})) as { tools?: McpToolDefinition[] };
    return resp.tools ?? [];
  }

  /** Invoke an MCP tool. Results cached per (tool,args) for the category TTL. */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<McpCallResult> {
    if (!this.configured) {
      return { error: "MCP gateway not configured", _unavailable: true };
    }
    const key = `${toolName}:${stableStringify(args)}`;
    if (!opts.bypassCache) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return { ...hit.value, _cached: true };
    }

    const started = Date.now();
    const raw = (await this.request("/tools/call", { name: toolName, arguments: args })) as McpCallResult;
    const latencyMs = Date.now() - started;
    const sized = this.enforceSizeLimit(raw);

    const ttl = CATEGORY_TTL_MS[inferCategory(toolName)] ?? CATEGORY_TTL_MS.default;
    this.cache.set(key, { value: { ...sized, _latencyMs: latencyMs }, expiresAt: Date.now() + ttl });
    return { ...sized, _latencyMs: latencyMs };
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`MCP gateway ${res.status}: ${text.slice(0, 300)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cap oversized tool results so they don't blow the model context window. */
  private enforceSizeLimit(result: McpCallResult): McpCallResult {
    const serialized = JSON.stringify(result);
    if (serialized.length <= this.maxResultBytes) return result;
    logger.warn(
      { bytes: serialized.length, cap: this.maxResultBytes },
      "mcp: tool result truncated to a shape summary",
    );
    return {
      _truncated: true,
      _originalSizeBytes: serialized.length,
      _summary: summarizeShape(result),
    };
  }
}

function inferCategory(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t.startsWith("claims-analytics")) return "claims";
  if (t.startsWith("hospital-quality") || t.startsWith("service-area")) return "quality";
  if (t.startsWith("financial-intelligence") || t.startsWith("price-transparency")) return "finance";
  if (t.startsWith("web-intelligence")) return "news";
  if (t.startsWith("cms-facility") || t.startsWith("health-system-profiler")) return "facility";
  return "default";
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = (obj as Record<string, unknown>)[k];
  return JSON.stringify(ordered);
}

function summarizeShape(obj: unknown, depth = 0): unknown {
  if (depth > 3) return "<deep>";
  if (Array.isArray(obj)) {
    return { _arrayLength: obj.length, _first10: obj.slice(0, 10).map((i) => summarizeShape(i, depth + 1)) };
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = summarizeShape(v, depth + 1);
    return out;
  }
  return obj;
}

/** Process-wide singleton. */
export const mcpGateway = new McpLiveGatewayClient();
