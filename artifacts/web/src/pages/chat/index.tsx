/**
 * ChatProspecting — the v2.0 chat-first prospecting page.
 *
 * Owns all chat state via useReducer; the SSE client (lib/chat-sse.ts) feeds
 * events into dispatch. Routed at /chat and /chat/:sessionId inside AppLayout.
 */
import { useEffect, useReducer, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { ChatMessageList } from "@/components/chat/message-list";
import { ChatComposer } from "@/components/chat/composer";
import type { UiMessage, InflightTurn } from "@/components/chat/chat-types";
import type { TickerEntry } from "@/components/chat/tool-ticker";
import {
  streamChatMessage,
  chatApi,
  type ChatSessionSummary,
  type ChatMessageRow,
} from "@/lib/chat-sse";
import { AlertTriangle } from "lucide-react";

interface State {
  messages: UiMessage[];
  inflight: InflightTurn | null;
  streaming: boolean;
  costUsd: number;
  error: string | null;
}

type Action =
  | { t: "reset" }
  | { t: "loadMessages"; messages: UiMessage[] }
  | { t: "appendUser"; text: string }
  | { t: "startTurn" }
  | { t: "token"; text: string }
  | { t: "toolCall"; id: string; tool: string }
  | { t: "toolResult"; id: string; latencyMs: number; isError: boolean }
  | { t: "prospect"; opportunityId: string; summary: string }
  | { t: "addCost"; usd: number }
  | { t: "commit" }
  | { t: "error"; message: string };

let idSeq = 0;
const nextId = () => `m${++idSeq}_${Date.now()}`;

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "reset":
      return { messages: [], inflight: null, streaming: false, costUsd: 0, error: null };
    case "loadMessages":
      return { ...s, messages: a.messages, inflight: null, streaming: false, error: null };
    case "appendUser":
      return {
        ...s,
        messages: [...s.messages, { id: nextId(), role: "user", text: a.text }],
        error: null,
      };
    case "startTurn":
      return { ...s, inflight: { text: "", ticker: [], prospects: [] }, streaming: true };
    case "token":
      if (!s.inflight) return s;
      return { ...s, inflight: { ...s.inflight, text: s.inflight.text + a.text } };
    case "toolCall": {
      if (!s.inflight) return s;
      const entry: TickerEntry = { id: a.id, tool: a.tool, startedAt: Date.now() };
      return { ...s, inflight: { ...s.inflight, ticker: [...s.inflight.ticker, entry] } };
    }
    case "toolResult": {
      if (!s.inflight) return s;
      return {
        ...s,
        inflight: {
          ...s.inflight,
          ticker: s.inflight.ticker.map((e) =>
            e.id === a.id
              ? { ...e, completedAt: Date.now(), latencyMs: a.latencyMs, isError: a.isError }
              : e,
          ),
        },
      };
    }
    case "prospect": {
      if (!s.inflight) return s;
      return {
        ...s,
        inflight: {
          ...s.inflight,
          prospects: [
            ...s.inflight.prospects,
            { opportunityId: a.opportunityId, summary: a.summary },
          ],
        },
      };
    }
    case "addCost":
      return { ...s, costUsd: s.costUsd + a.usd };
    case "commit": {
      if (!s.inflight) return { ...s, streaming: false };
      const assistant: UiMessage = {
        id: nextId(),
        role: "assistant",
        text: s.inflight.text || "(no text response)",
        ticker: s.inflight.ticker,
        prospects: s.inflight.prospects,
      };
      return { ...s, messages: [...s.messages, assistant], inflight: null, streaming: false };
    }
    case "error":
      return { ...s, error: a.message, streaming: false, inflight: null };
    default:
      return s;
  }
}

/** Convert persisted chat_messages rows into render-ready UI messages. */
function historyToUi(rows: ChatMessageRow[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      out.push({
        id: `h${r.id}`,
        role: "user",
        text: typeof r.content === "string" ? r.content : extractText(r.content),
      });
    } else if (r.role === "assistant") {
      const text = extractText(r.content);
      if (text.trim()) out.push({ id: `h${r.id}`, role: "assistant", text });
    }
    // 'tool' rows hold tool_result blocks — not rendered.
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        Boolean(b && typeof b === "object" && (b as { type?: string }).type === "text"),
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

export default function ChatProspectingPage() {
  const params = useParams();
  const sessionId = params.sessionId as string | undefined;
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    inflight: null,
    streaming: false,
    costUsd: 0,
    error: null,
  });

  const [sessions, setSessions] = useReducer(
    (_: ChatSessionSummary[], next: ChatSessionSummary[]) => next,
    [],
  );
  const abortRef = useRef<(() => void) | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions: list } = await chatApi.listSessions();
      setSessions(list);
    } catch {
      /* sidebar is non-critical */
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Load the active session's history when the route changes.
  useEffect(() => {
    dispatch({ t: "reset" });
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const { messages } = await chatApi.getSession(sessionId);
        if (!cancelled) dispatch({ t: "loadMessages", messages: historyToUi(messages) });
      } catch {
        if (!cancelled) dispatch({ t: "error", message: "Could not load that session." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const runMessage = useCallback(
    (sid: string, text: string) => {
      dispatch({ t: "appendUser", text });
      dispatch({ t: "startTurn" });
      const { abort } = streamChatMessage(sid, text, {
        onToken: (t) => dispatch({ t: "token", text: t }),
        onToolCall: (e) => dispatch({ t: "toolCall", id: e.id, tool: e.tool }),
        onToolResult: (e) =>
          dispatch({ t: "toolResult", id: e.id, latencyMs: e.latencyMs, isError: e.isError }),
        onProspect: (e) =>
          dispatch({ t: "prospect", opportunityId: e.opportunityId, summary: e.summary }),
        onUsage: (e) => dispatch({ t: "addCost", usd: e.costUsd }),
        onError: (msg) => dispatch({ t: "error", message: msg }),
        onDone: () => {
          dispatch({ t: "commit" });
          void refreshSessions();
        },
      });
      abortRef.current = abort;
    },
    [refreshSessions],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (sessionId) {
        runMessage(sessionId, text);
        return;
      }
      // No active session — create one, navigate, then send.
      try {
        const { sessionId: newId } = await chatApi.createSession(text.slice(0, 60));
        await refreshSessions();
        navigate(`/chat/${newId}`);
        // Give the route effect a tick to reset, then stream.
        setTimeout(() => runMessage(newId, text), 50);
      } catch {
        toast({ title: "Could not start a chat session", variant: "destructive" });
      }
    },
    [sessionId, runMessage, refreshSessions, navigate, toast],
  );

  const handleNew = useCallback(() => {
    if (abortRef.current) abortRef.current();
    navigate("/chat");
  }, [navigate]);

  const handleCancel = useCallback(() => {
    if (abortRef.current) abortRef.current();
    dispatch({ t: "commit" });
  }, []);

  return (
    <div className="-m-4 lg:-m-8 flex h-[calc(100vh-3.5rem)]">
      <aside className="w-64 border-r border-border bg-card hidden md:flex flex-col shrink-0">
        <SessionSidebar
          sessions={sessions}
          activeId={sessionId ?? null}
          onNew={handleNew}
          onSelect={(id) => navigate(`/chat/${id}`)}
        />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-border bg-card px-4 sm:px-6 py-3">
          <h1 className="text-base font-semibold">Prospecting Chat</h1>
          <p className="text-xs text-muted-foreground">
            Describe what you sell and where — the agent finds and qualifies your prospects.
          </p>
        </div>

        {state.error && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 sm:px-6 py-2 text-sm text-amber-800 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {state.error}
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <ChatMessageList
            messages={state.messages}
            inflight={state.inflight}
            streaming={state.streaming}
            onSuggestion={handleSend}
          />
        </div>

        <div className="border-t border-border bg-card">
          <ChatComposer
            disabled={false}
            streaming={state.streaming}
            costUsd={state.costUsd}
            onSend={handleSend}
            onCancel={handleCancel}
          />
        </div>
      </div>
    </div>
  );
}
