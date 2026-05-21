/**
 * SubAgentInvoker — runs a specialist persona as a one-shot Anthropic call.
 *
 * Adapted from the handoff's SubAgentInvoker.js. Adaptations:
 *  - TypeScript; uses the repo's shared `anthropic` client + Drizzle `db`.
 *  - The persona markdown is vendored in-repo at vendor/sub-agents/<file>.md
 *    (the handoff vendored two git submodules; the operator chose Tier-A only,
 *    so the 15 Tier-A personas are vendored directly).
 *  - No PaidSourceGate: the main ProspectingAgent's own Anthropic calls are
 *    not gated, and a sub-agent call is just one more Anthropic call inside
 *    the same turn. Spend is already bounded by AgentRateLimiter's cost
 *    ceilings (sub-agent cost folds into the turn cost) and by the agent's
 *    per-turn consultation cap.
 *
 * Sub-agents have NO tool access — they reason only. The main agent gathers
 * data via its own tools and passes it in as `context`. This keeps each
 * consultation fast, cheap, and predictable.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { eq } from "drizzle-orm";
import { db, subAgentRegistry, subAgentInvocations } from "@workspace/db";
import type { SubAgentRegistryRow } from "@workspace/db";
import { logger } from "../../lib/logger";

/** $ per 1M tokens, by model. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-sonnet-4-5": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { in: 0.8, out: 4.0 },
};
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

/** Persona body cache — read each markdown file once per process. */
const PERSONA_CACHE = new Map<string, string>();

export interface ConsultInput {
  agentName: string;
  context?: string;
  question: string;
  accountId: string;
  userId?: string | null;
  sessionId?: string | null;
}

export interface ConsultResult {
  agentName: string;
  displayName: string;
  emoji: string | null;
  category: string;
  response: string;
  status: "success" | "error" | "disabled";
  model: string;
  costUsd: number;
  latencyMs: number;
}

/** Walk up from cwd to find the repo's vendor/sub-agents directory. */
function resolveVendorRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "vendor", "sub-agents");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "vendor", "sub-agents");
}

export class SubAgentInvoker {
  private vendorRoot: string;

  constructor(opts: { vendorRoot?: string } = {}) {
    this.vendorRoot = opts.vendorRoot ?? resolveVendorRoot();
  }

  /** Tier-A roster — auto-loaded into the main agent's tool catalog. */
  async listTierA(): Promise<SubAgentRegistryRow[]> {
    return db
      .select()
      .from(subAgentRegistry)
      .where(eq(subAgentRegistry.tier, "A"));
  }

  /**
   * Run one consultation. Never throws — failures come back as a `status:
   * "error"` result so the main agent can continue and note the gap.
   */
  async consult(input: ConsultInput): Promise<ConsultResult> {
    const { agentName, context, question, accountId, userId, sessionId } = input;

    const [row] = await db
      .select()
      .from(subAgentRegistry)
      .where(eq(subAgentRegistry.agentName, agentName))
      .limit(1);

    if (!row || !row.enabled) {
      const response = row
        ? `The ${row.displayName} sub-agent is currently disabled.`
        : `No sub-agent is registered under "${agentName}".`;
      // Only log when the registry row exists — sub_agent_invocations.agent_name
      // is an FK, so an unregistered name has nothing to reference.
      if (row) {
        await this.logInvocation({
          agentName,
          accountId,
          userId,
          sessionId,
          question,
          status: "disabled",
          errorMessage: response,
        });
      }
      return {
        agentName,
        displayName: row?.displayName ?? agentName,
        emoji: row?.emoji ?? null,
        category: row?.category ?? "default",
        response,
        status: "disabled",
        model: DEFAULT_MODEL,
        costUsd: 0,
        latencyMs: 0,
      };
    }

    const model = row.recommendedModel ?? DEFAULT_MODEL;
    const startedAt = Date.now();
    let response = "";
    let status: ConsultResult["status"] = "success";
    let errorMessage: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const personaPrompt = this.loadPersona(row);
      const result = await anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: personaPrompt,
        messages: [{ role: "user", content: buildUserMessage(context, question) }],
      });
      response = result.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      inputTokens = result.usage.input_tokens ?? 0;
      outputTokens = result.usage.output_tokens ?? 0;
    } catch (err) {
      status = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      response = `The ${row.displayName} sub-agent could not be reached (${errorMessage}). Continuing without it.`;
      logger.warn({ agentName, err: errorMessage }, "sub-agent: consultation failed");
    }

    const latencyMs = Date.now() - startedAt;
    const costUsd = computeCost(model, inputTokens, outputTokens);

    await this.logInvocation({
      agentName,
      accountId,
      userId,
      sessionId,
      question,
      contextSummary: context ? context.slice(0, 4000) : null,
      responseText: response,
      requestTokens: inputTokens,
      responseTokens: outputTokens,
      modelUsed: model,
      costUsd,
      latencyMs,
      status,
      errorMessage,
    });

    return {
      agentName,
      displayName: row.displayName,
      emoji: row.emoji,
      category: row.category,
      response,
      status,
      model,
      costUsd,
      latencyMs,
    };
  }

  /** Load + cache a persona body, frontmatter stripped, consultation-framed. */
  private loadPersona(row: SubAgentRegistryRow): string {
    const cached = PERSONA_CACHE.get(row.agentName);
    if (cached) return cached;

    const absPath = resolve(this.vendorRoot, row.sourcePath);
    let raw: string;
    try {
      raw = readFileSync(absPath, "utf8");
    } catch (err) {
      throw new Error(
        `persona markdown missing for ${row.agentName} at ${absPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const framed = [
      body,
      "",
      "## Consultation context (added by MedIntel)",
      "",
      "You are being consulted by the MedIntel Prospecting Agent, which is helping a",
      "medical capital-equipment sales rep evaluate a target facility. Give a focused,",
      "actionable answer in plain prose. Cite specific frameworks, regulations, or",
      "numeric benchmarks where they apply. If the question is outside your expertise,",
      "say so plainly and name the specialist who would fit better. Keep the answer",
      "under 400 words unless the question genuinely demands more.",
    ].join("\n");

    PERSONA_CACHE.set(row.agentName, framed);
    return framed;
  }

  private async logInvocation(fields: {
    agentName: string;
    accountId: string;
    userId?: string | null;
    sessionId?: string | null;
    question: string;
    contextSummary?: string | null;
    responseText?: string | null;
    requestTokens?: number;
    responseTokens?: number;
    modelUsed?: string;
    costUsd?: number;
    latencyMs?: number;
    status: string;
    errorMessage?: string | null;
  }): Promise<void> {
    try {
      await db.insert(subAgentInvocations).values({
        sessionId: fields.sessionId ?? null,
        accountId: fields.accountId,
        userId: fields.userId ?? null,
        agentName: fields.agentName,
        question: fields.question,
        contextSummary: fields.contextSummary ?? null,
        responseText: fields.responseText ?? null,
        responseTokens: fields.responseTokens ?? null,
        requestTokens: fields.requestTokens ?? null,
        modelUsed: fields.modelUsed ?? null,
        costUsd: String(fields.costUsd ?? 0),
        latencyMs: fields.latencyMs ?? null,
        status: fields.status,
        errorMessage: fields.errorMessage ?? null,
      });
    } catch (err) {
      // Audit logging must never break a consultation.
      logger.warn(
        { agentName: fields.agentName, err: err instanceof Error ? err.message : String(err) },
        "sub-agent: invocation log failed",
      );
    }
  }
}

function buildUserMessage(context: string | undefined, question: string): string {
  const parts: string[] = [];
  if (context && context.trim()) {
    parts.push("## Context the main agent has gathered\n\n" + context.trim(), "");
  }
  parts.push("## Question\n\n" + question);
  return parts.join("\n");
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  return (inputTokens / 1_000_000) * price.in + (outputTokens / 1_000_000) * price.out;
}

/** Process-wide singleton — the persona cache is shared across requests. */
export const subAgentInvoker = new SubAgentInvoker();
