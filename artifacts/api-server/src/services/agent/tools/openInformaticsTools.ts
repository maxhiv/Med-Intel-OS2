/**
 * openInformaticsTools — wraps the healthcare-data-mcp live-gateway's tool
 * catalog as ProspectingAgent tools.
 *
 * Fail-soft: if the gateway isn't configured/reachable, this returns an empty
 * registry and the agent simply runs without the 138 MCP tools. The catalog
 * is discovered live at session start via `mcpGateway.listTools()`.
 *
 * Paid sub-integrations inside the gateway (ORS, Proxycurl, Google CSE,
 * NewsAPI, CHPL) are dual-gate-checked before the call; free tools pass
 * straight through.
 */
import { logger } from "../../../lib/logger";
import { mcpGateway, type McpToolDefinition } from "../mcpLiveGatewayClient";
import { paidSourceGate } from "../paidSourceGate";
import type { AgentToolDefinition, ToolBuildContext, ToolRegistry, ToolExecutor } from "./types";

/** MCP tool-name prefix → the paid source it depends on (if any). */
const PAID_PREFIX: Record<string, string> = {
  "drive-time": "openrouteservice",
  "web-intelligence": "google_custom_search",
};

function objectSchema(raw: unknown): AgentToolDefinition["input_schema"] {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    type: "object",
    properties: (s.properties as Record<string, unknown>) ?? {},
    required: Array.isArray(s.required) ? (s.required as string[]) : undefined,
  };
}

export async function buildOpenInformaticsTools(ctx: ToolBuildContext): Promise<ToolRegistry> {
  const definitions: AgentToolDefinition[] = [];
  const executors = new Map<string, ToolExecutor>();

  if (!mcpGateway.configured) {
    logger.info("agent: MCP gateway not configured — skipping the 138 Open-Informatics tools");
    return { definitions, executors };
  }

  let catalog: McpToolDefinition[] = [];
  try {
    catalog = await mcpGateway.listTools();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "agent: MCP gateway unreachable — running without Open-Informatics tools",
    );
    return { definitions, executors };
  }

  for (const tool of catalog) {
    const name = tool.name;
    definitions.push({
      name,
      description: tool.description ?? `Open-Informatics MCP tool: ${name}`,
      input_schema: objectSchema(tool.input_schema ?? tool.inputSchema),
    });

    const paidSource = Object.entries(PAID_PREFIX).find(([prefix]) =>
      name.startsWith(prefix),
    )?.[1];

    executors.set(name, async (args) => {
      // Gate the paid sub-integrations.
      if (paidSource) {
        const check = await paidSourceGate.check({
          sourceName: paidSource,
          accountId: ctx.accountId,
          userId: ctx.userId,
          toolName: name,
          sessionId: ctx.sessionId,
        });
        await paidSourceGate.logCall({
          ...check.audit,
          responseStatus: check.allowed ? "success" : check.reason!,
        });
        if (!check.allowed) {
          return { content: { gated: true, reason: check.reason, message: check.userMessage } };
        }
      }

      try {
        const result = await mcpGateway.callTool(name, args);
        return { content: result };
      } catch (err) {
        return {
          content: { error: err instanceof Error ? err.message : String(err) },
          isError: true,
        };
      }
    });
  }

  logger.info({ toolCount: definitions.length }, "agent: Open-Informatics MCP tools loaded");
  return { definitions, executors };
}
