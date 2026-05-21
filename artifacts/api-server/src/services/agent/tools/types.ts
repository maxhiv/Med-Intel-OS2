/**
 * Shared types for the ProspectingAgent tool registry.
 *
 * Each tool category (MCP, proprietary, database/action) exports a builder
 * that returns a `ToolRegistry`: Anthropic-format tool definitions plus a
 * name→executor map. The agent merges all categories into one registry.
 */

/** Anthropic tool-use definition shape. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A specialist sub-agent consultation surfaced by a `consult_*` tool. */
export interface SubAgentConsultation {
  agentName: string;
  displayName: string;
  emoji: string | null;
  category: string;
  question: string;
  response: string;
  status: "success" | "error" | "disabled";
  costUsd: number;
  latencyMs: number;
}

/** Result of executing a tool. `content` is fed back to the model. */
export interface ToolExecutionResult {
  content: unknown;
  isError?: boolean;
  /** When set, the agent emits an onProspect SSE event. */
  prospectSurfaced?: { opportunityId: string; summary: string };
  /** When set, the agent emits an onSubAgent SSE event. */
  subAgent?: SubAgentConsultation;
  /** Per-call cost to fold into the turn total (e.g. paid MCP tools). */
  costUsd?: number;
}

export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolExecutionResult>;

export interface ToolRegistry {
  definitions: AgentToolDefinition[];
  executors: Map<string, ToolExecutor>;
}

/** Context passed to every tool builder. */
export interface ToolBuildContext {
  accountId: string;
  userId: string;
  sessionId: string;
}
