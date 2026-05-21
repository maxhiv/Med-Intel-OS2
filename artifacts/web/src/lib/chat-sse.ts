/**
 * chat-sse — Server-Sent-Events client for the ProspectingAgent chat API.
 *
 * Uses fetch + ReadableStream rather than EventSource because:
 *   - EventSource can't POST (we send the message body)
 *   - fetch streaming gives us abort control
 * Auth rides on the same-origin Clerk session cookie (credentials: "include").
 *
 * The PR C chat route emits these event types:
 *   token | tool_call | tool_result | prospect | usage | error | done
 */

export interface ChatToolCall {
  id: string;
  tool: string;
  args?: unknown;
}
export interface ChatToolResult {
  id: string;
  tool: string;
  latencyMs: number;
  isError: boolean;
}
export interface ChatProspect {
  opportunityId: string;
  summary: string;
}
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export interface ChatDone {
  stopReason: string | null;
  costUsd?: number;
  toolCalls?: number;
  error?: string;
}

export interface ChatStreamHandlers {
  onToken?: (text: string) => void;
  onToolCall?: (e: ChatToolCall) => void;
  onToolResult?: (e: ChatToolResult) => void;
  onProspect?: (e: ChatProspect) => void;
  onUsage?: (e: ChatUsage) => void;
  onError?: (message: string, code?: string) => void;
  onDone?: (e: ChatDone) => void;
}

/**
 * POST a message to a chat session and stream the agent's SSE response,
 * dispatching each event to the matching handler. Returns an abort fn.
 */
export function streamChatMessage(
  sessionId: string,
  message: string,
  handlers: ChatStreamHandlers,
): { abort: () => void; done: Promise<void> } {
  const controller = new AbortController();

  const done = (async () => {
    let res: Response;
    try {
      res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
        credentials: "include",
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        handlers.onError?.(`Connection failed: ${(err as Error).message}`);
      }
      return;
    }

    if (!res.ok || !res.body) {
      handlers.onError?.(`Stream failed: HTTP ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim() || part.startsWith(":")) continue;
          dispatch(part, handlers);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        handlers.onError?.(`Stream error: ${(err as Error).message}`);
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return { abort: () => controller.abort(), done };
}

function dispatch(rawEvent: string, h: ChatStreamHandlers): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }

  switch (eventName) {
    case "token":
      h.onToken?.(String(data.text ?? ""));
      break;
    case "tool_call":
      h.onToolCall?.(data as unknown as ChatToolCall);
      break;
    case "tool_result":
      h.onToolResult?.(data as unknown as ChatToolResult);
      break;
    case "prospect":
      h.onProspect?.(data as unknown as ChatProspect);
      break;
    case "usage":
      h.onUsage?.(data as unknown as ChatUsage);
      break;
    case "error":
      h.onError?.(String(data.message ?? "An error occurred"), data.code as string | undefined);
      break;
    case "done":
      h.onDone?.(data as unknown as ChatDone);
      break;
  }
}

// ─── Non-streaming session CRUD ─────────────────────────────────────────────

import { customFetch } from "@workspace/api-client-react";

export interface ChatSessionSummary {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
  lastMessageAt: string;
  totalCostUsd: string;
}
export interface ChatMessageRow {
  id: number;
  role: string;
  content: unknown;
  createdAt: string;
}

export const chatApi = {
  createSession: (title?: string) =>
    customFetch<{ sessionId: string; createdAt: string }>("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  listSessions: () =>
    customFetch<{ sessions: ChatSessionSummary[] }>("/api/chat/sessions"),
  getSession: (id: string) =>
    customFetch<{ session: ChatSessionSummary; messages: ChatMessageRow[] }>(
      `/api/chat/sessions/${id}`,
    ),
  archiveSession: (id: string) =>
    customFetch(`/api/chat/sessions/${id}`, { method: "DELETE" }),
};
