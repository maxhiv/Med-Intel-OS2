/**
 * ProspectingAgent — the v2.0 chat-first reasoning agent.
 *
 * Adapted from the handoff's ProspectingAgent.js. Adaptations:
 *  - TypeScript; uses the repo's shared `anthropic` client + Drizzle `db`.
 *  - The chat route establishes the RLS scope (withRLS), so every db call
 *    here is already account-isolated — no per-call tenant context needed.
 *  - PR E adds a fourth tool category: the Tier-A sub-agents, surfaced as
 *    `consult_*` tools that route through SubAgentInvoker.
 *
 * Streaming: the agent calls Anthropic non-streaming in a tool loop and
 * surfaces progress through callbacks (onToken / onToolCall / onToolResult /
 * onProspect / onSubAgent / onUsage). The chat route turns those into SSE.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, chatMessages, chatSessions } from "@workspace/db";
import { logger } from "../../lib/logger";
import { buildSystemPrompt } from "./buildSystemPrompt";
import { agentRateLimiter } from "./agentRateLimiter";
import { buildOpenInformaticsTools } from "./tools/openInformaticsTools";
import { buildMedIntelTools } from "./tools/medintelTools";
import { buildDatabaseAndActionTools } from "./tools/databaseAndActionTools";
import { buildSubAgentTools } from "./tools/subAgentTools";
import type { AgentToolDefinition, SubAgentConsultation, ToolExecutor } from "./tools/types";

/** $ per 1M tokens. cachedIn = prompt-cache read rate. */
const PRICING: Record<string, { in: number; out: number; cachedIn: number }> = {
  "claude-sonnet-4-6": { in: 3.0, out: 15.0, cachedIn: 0.3 },
  "claude-sonnet-4-5": { in: 3.0, out: 15.0, cachedIn: 0.3 },
  "claude-haiku-4-5": { in: 0.8, out: 4.0, cachedIn: 0.08 },
};
const DEFAULT_MODEL = process.env.ANTHROPIC_AGENT_MODEL ?? "claude-sonnet-4-6";

export interface AgentCallbacks {
  onToken?: (text: string) => void;
  onToolCall?: (e: { id: string; tool: string; args: unknown }) => void;
  onToolResult?: (e: { id: string; tool: string; latencyMs: number; isError: boolean }) => void;
  onProspect?: (e: { opportunityId: string; summary: string }) => void;
  onSubAgent?: (e: SubAgentConsultation) => void;
  onUsage?: (e: { inputTokens: number; outputTokens: number; costUsd: number }) => void;
  onError?: (err: Error) => void;
}

export interface AgentTurnResult {
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
  subAgentCalls: number;
  costUsd: number;
  latencyMs: number;
}

type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicContentBlock = Anthropic.ContentBlockParam;

export class ProspectingAgent {
  readonly accountId: string;
  readonly userId: string;
  readonly sessionId: string;
  private model = DEFAULT_MODEL;
  private maxTokens = parseInt(process.env.ANTHROPIC_AGENT_MAX_TOKENS ?? "4096", 10);
  private maxToolCallsPerTurn = parseInt(
    process.env.ANTHROPIC_AGENT_MAX_TOOL_CALLS_PER_TURN ?? "25",
    10,
  );
  private maxSubAgentCallsPerTurn = parseInt(
    process.env.ANTHROPIC_AGENT_MAX_SUB_AGENT_CALLS_PER_TURN ?? "3",
    10,
  );
  private promptCaching = (process.env.ANTHROPIC_PROMPT_CACHING_ENABLED ?? "true") === "true";

  private systemPrompt = "";
  private toolDefs: AgentToolDefinition[] = [];
  private executors = new Map<string, ToolExecutor>();
  private subAgentToolNames = new Set<string>();
  private messages: AnthropicMessageParam[] = [];
  private initialized = false;

  constructor(opts: { accountId: string; userId: string; sessionId: string }) {
    this.accountId = opts.accountId;
    this.userId = opts.userId;
    this.sessionId = opts.sessionId;
  }

  /** Build the system prompt + tool registry, restore conversation history. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.systemPrompt = await buildSystemPrompt(this.accountId, this.userId);

    const ctx = { accountId: this.accountId, userId: this.userId, sessionId: this.sessionId };
    const [mcp, medintel, dbTools, subAgents] = await Promise.all([
      buildOpenInformaticsTools(ctx),
      Promise.resolve(buildMedIntelTools()),
      Promise.resolve(buildDatabaseAndActionTools(ctx)),
      buildSubAgentTools(ctx),
    ]);
    this.toolDefs = [
      ...mcp.definitions,
      ...medintel.definitions,
      ...dbTools.definitions,
      ...subAgents.definitions,
    ];
    this.executors = new Map([
      ...mcp.executors,
      ...medintel.executors,
      ...dbTools.executors,
      ...subAgents.executors,
    ]);
    this.subAgentToolNames = new Set(subAgents.definitions.map((d) => d.name));

    this.messages = await this.loadHistory();
    this.initialized = true;
    logger.info(
      {
        sessionId: this.sessionId,
        tools: this.toolDefs.length,
        subAgents: this.subAgentToolNames.size,
        historyLen: this.messages.length,
      },
      "agent: initialized",
    );
  }

  /** Process one user message. Streams progress via callbacks; returns turn stats. */
  async sendMessage(userText: string, cb: AgentCallbacks = {}): Promise<AgentTurnResult> {
    if (!this.initialized) await this.init();

    const rate = await agentRateLimiter.check({ accountId: this.accountId, userId: this.userId });
    if (!rate.allowed) {
      const err = Object.assign(new Error(rate.userMessage ?? "Rate limit reached"), {
        code: rate.reason,
      });
      cb.onError?.(err);
      throw err;
    }

    this.messages.push({ role: "user", content: userText });
    await this.persistMessage("user", userText);

    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let costUsd = 0;
    let toolCalls = 0;
    let subAgentCalls = 0;
    let subAgentCost = 0;
    let stopReason: string | null = null;

    for (let iter = 0; iter <= this.maxToolCallsPerTurn; iter++) {
      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.promptCaching
            ? [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }]
            : this.systemPrompt,
          tools: this.toolDefs as Anthropic.Tool[],
          messages: this.messages,
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        cb.onError?.(e);
        throw e;
      }

      const u = response.usage;
      const inT = u.input_tokens ?? 0;
      const outT = u.output_tokens ?? 0;
      const cachedT = u.cache_read_input_tokens ?? 0;
      inputTokens += inT;
      outputTokens += outT;
      cachedTokens += cachedT;
      const turnCost = this.computeCost(inT, outT, cachedT);
      costUsd += turnCost;
      cb.onUsage?.({ inputTokens: inT, outputTokens: outT, costUsd: turnCost });

      for (const block of response.content) {
        if (block.type === "text") cb.onToken?.(block.text);
      }

      this.messages.push({ role: "assistant", content: response.content });
      stopReason = response.stop_reason;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0 || stopReason !== "tool_use") {
        await this.persistMessage("assistant", null, response.content, {
          inputTokens,
          outputTokens,
          cachedTokens,
          costUsd,
        });
        break;
      }

      const results: AnthropicContentBlock[] = [];
      for (const tu of toolUses) {
        if (toolCalls >= this.maxToolCallsPerTurn) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Per-turn tool-call cap reached — answer with what you have.",
            is_error: true,
          });
          continue;
        }
        if (
          this.subAgentToolNames.has(tu.name) &&
          subAgentCalls >= this.maxSubAgentCallsPerTurn
        ) {
          cb.onToolCall?.({ id: tu.id, tool: tu.name, args: tu.input });
          cb.onToolResult?.({ id: tu.id, tool: tu.name, latencyMs: 0, isError: true });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Sub-agent consultation cap reached (${this.maxSubAgentCallsPerTurn} per turn). Synthesize your answer from the consultations you already have.`,
            is_error: true,
          });
          continue;
        }
        toolCalls++;
        cb.onToolCall?.({ id: tu.id, tool: tu.name, args: tu.input });
        const t0 = Date.now();
        const exec = this.executors.get(tu.name);
        let resultContent: unknown;
        let isError = false;
        if (!exec) {
          resultContent = { error: `Unknown tool: ${tu.name}` };
          isError = true;
        } else {
          try {
            const r = await exec((tu.input ?? {}) as Record<string, unknown>);
            resultContent = r.content;
            isError = r.isError === true;
            if (r.prospectSurfaced) cb.onProspect?.(r.prospectSurfaced);
            if (r.subAgent) {
              cb.onSubAgent?.(r.subAgent);
              subAgentCalls++;
              subAgentCost += r.subAgent.costUsd;
            }
            if (typeof r.costUsd === "number") costUsd += r.costUsd;
          } catch (err) {
            resultContent = { error: err instanceof Error ? err.message : String(err) };
            isError = true;
          }
        }
        cb.onToolResult?.({ id: tu.id, tool: tu.name, latencyMs: Date.now() - t0, isError });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent),
          is_error: isError,
        });
      }
      this.messages.push({ role: "user", content: results });
      await this.persistMessage("tool", null, results);
    }

    await agentRateLimiter.recordQuery({
      accountId: this.accountId,
      userId: this.userId,
      anthropicCostUsd: costUsd,
      subAgentCalls,
      subAgentCostUsd: subAgentCost,
    });
    await this.updateSessionTotals(inputTokens, outputTokens, costUsd);

    return {
      stopReason,
      inputTokens,
      outputTokens,
      cachedTokens,
      toolCalls,
      subAgentCalls,
      costUsd,
      latencyMs: Date.now() - started,
    };
  }

  // ─── private ────────────────────────────────────────────────────────────

  private computeCost(inT: number, outT: number, cachedT: number): number {
    const p = PRICING[this.model] ?? PRICING["claude-sonnet-4-6"];
    const uncachedIn = Math.max(0, inT - cachedT);
    return (
      (uncachedIn / 1_000_000) * p.in +
      (cachedT / 1_000_000) * p.cachedIn +
      (outT / 1_000_000) * p.out
    );
  }

  private async loadHistory(): Promise<AnthropicMessageParam[]> {
    const rows = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, this.sessionId))
      .orderBy(asc(chatMessages.createdAt));
    return rows.map((r) => ({
      // 'tool' rows are tool_result blocks — Anthropic expects them on a user turn.
      role: r.role === "assistant" ? "assistant" : "user",
      content: r.content as AnthropicMessageParam["content"],
    }));
  }

  private async persistMessage(
    role: "user" | "assistant" | "tool",
    text: string | null,
    structured?: unknown,
    tokenUsage?: unknown,
  ): Promise<void> {
    await db.insert(chatMessages).values({
      sessionId: this.sessionId,
      role,
      content: (structured ?? text ?? "") as Record<string, unknown>,
      tokenUsage: (tokenUsage ?? null) as Record<string, unknown> | null,
    });
  }

  private async updateSessionTotals(
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
  ): Promise<void> {
    await db
      .update(chatSessions)
      .set({
        totalTokensIn: sql`${chatSessions.totalTokensIn} + ${tokensIn}`,
        totalTokensOut: sql`${chatSessions.totalTokensOut} + ${tokensOut}`,
        totalCostUsd: sql`${chatSessions.totalCostUsd} + ${costUsd}`,
        lastMessageAt: new Date(),
      })
      .where(
        and(eq(chatSessions.id, this.sessionId), eq(chatSessions.accountId, this.accountId)),
      );
  }
}
