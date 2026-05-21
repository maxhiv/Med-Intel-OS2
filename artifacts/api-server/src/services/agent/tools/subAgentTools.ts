/**
 * subAgentTools — turns the Tier-A sub-agent roster into ProspectingAgent tools.
 *
 * For each Tier-A row in sub_agent_registry, emits a `consult_<name>` tool with
 * a consistent (context, question) schema. Each executor routes through
 * SubAgentInvoker.consult(), which loads the persona, runs a one-shot Anthropic
 * call, logs the invocation, and returns the specialist's answer.
 *
 * The operator chose Tier-A only (15 agents), so there is no Tier-B discovery
 * pair — every available sub-agent has its own dedicated tool.
 */
import { logger } from "../../../lib/logger";
import { subAgentInvoker } from "../subAgentInvoker";
import type { AgentToolDefinition, ToolBuildContext, ToolRegistry, ToolExecutor } from "./types";

/** `revenue-finance-manager` → `consult_revenue_finance_manager`. */
export function consultToolName(agentName: string): string {
  return `consult_${agentName.replaceAll("-", "_")}`;
}

export async function buildSubAgentTools(ctx: ToolBuildContext): Promise<ToolRegistry> {
  const definitions: AgentToolDefinition[] = [];
  const executors = new Map<string, ToolExecutor>();

  let roster: Awaited<ReturnType<typeof subAgentInvoker.listTierA>>;
  try {
    roster = await subAgentInvoker.listTierA();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "agent: sub-agent registry unavailable — running without consult tools",
    );
    return { definitions, executors };
  }

  for (const a of roster) {
    if (!a.enabled) continue;
    const toolName = consultToolName(a.agentName);
    definitions.push({
      name: toolName,
      description: `${a.emoji ?? "🧠"} Consult the ${a.displayName}. ${a.description}`,
      input_schema: {
        type: "object",
        properties: {
          context: {
            type: "string",
            description:
              "Structured context you have already gathered — facility profile, financials, ownership, trigger details. Sub-agents have no tools; they reason only on what you pass here.",
          },
          question: {
            type: "string",
            description:
              "The specific question for the specialist. Be precise — vague questions get vague answers.",
          },
        },
        required: ["question"],
      },
    });

    executors.set(toolName, async (args) => {
      const result = await subAgentInvoker.consult({
        agentName: a.agentName,
        context: typeof args.context === "string" ? args.context : undefined,
        question: String(args.question ?? ""),
        accountId: ctx.accountId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      });
      return {
        content: {
          sub_agent: result.displayName,
          status: result.status,
          response: result.response,
        },
        costUsd: result.costUsd,
        subAgent: {
          agentName: result.agentName,
          displayName: result.displayName,
          emoji: result.emoji,
          category: result.category,
          question: String(args.question ?? ""),
          response: result.response,
          status: result.status,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
        },
      };
    });
  }

  logger.info({ toolCount: definitions.length }, "agent: sub-agent consult tools loaded");
  return { definitions, executors };
}
