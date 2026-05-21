/**
 * ChatMessageList — the scrollable conversation transcript.
 *
 * Renders committed messages plus the in-flight assistant turn (streaming
 * text + live tool ticker + any prospects surfaced mid-turn). Auto-sticks to
 * the bottom unless the rep has scrolled up to read older content.
 */
import { useEffect, useRef } from "react";
import { Activity } from "lucide-react";
import { ToolTicker } from "./tool-ticker";
import { ChatProspectCard } from "./prospect-card";
import { SubAgentChip } from "./sub-agent-chip";
import type { UiMessage, InflightTurn } from "./chat-types";

const SUGGESTIONS = [
  "Find imaging centers in Texas with a high signal score.",
  "Which facilities in my data have recent HCRIS depreciation spikes?",
  "Show me hospitals in Oklahoma and surface the top 3 as opportunities.",
];

export function ChatMessageList({
  messages,
  inflight,
  streaming,
  onSuggestion,
}: {
  messages: UiMessage[];
  inflight: InflightTurn | null;
  streaming: boolean;
  onSuggestion: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stick.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, inflight]);

  const empty = messages.length === 0 && !inflight;

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-4 sm:px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-4">
        {empty && (
          <div className="text-center py-16">
            <h2 className="text-lg font-semibold">Start a prospecting conversation</h2>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              Describe what you sell and where. The agent searches your facility
              data and public sources, qualifies prospects, and drops them in
              your Opportunity Inbox.
            </p>
            <div className="mt-6 grid gap-2 max-w-md mx-auto text-left">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSuggestion(s)}
                  className="text-left px-4 py-3 bg-card border border-border rounded-lg text-sm hover:border-primary/40 hover:bg-accent transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {inflight && (
          <div className="bg-card rounded-lg border border-border px-5 py-4">
            {inflight.ticker.length > 0 && (
              <div className="mb-3">
                <ToolTicker entries={inflight.ticker} />
              </div>
            )}
            {inflight.subAgents.length > 0 && (
              <div className="mb-3 space-y-2">
                {inflight.subAgents.map((c, i) => (
                  <SubAgentChip key={`${c.agentName}-${i}`} consult={c} />
                ))}
              </div>
            )}
            {inflight.text ? (
              <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm">
                {inflight.text}
              </div>
            ) : streaming && inflight.ticker.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Activity className="h-4 w-4 animate-pulse" /> Thinking…
              </div>
            ) : null}
            {inflight.prospects.map((p) => (
              <div key={p.opportunityId} className="mt-3">
                <ChatProspectCard prospect={p} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-2xl bg-primary text-primary-foreground rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="bg-card rounded-lg border border-border px-5 py-4">
      {message.ticker && message.ticker.length > 0 && (
        <div className="mb-3">
          <ToolTicker entries={message.ticker} />
        </div>
      )}
      {message.subAgents && message.subAgents.length > 0 && (
        <div className="mb-3 space-y-2">
          {message.subAgents.map((c, i) => (
            <SubAgentChip key={`${c.agentName}-${i}`} consult={c} />
          ))}
        </div>
      )}
      {message.text && (
        <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm">
          {message.text}
        </div>
      )}
      {message.prospects?.map((p) => (
        <div key={p.opportunityId} className="mt-3">
          <ChatProspectCard prospect={p} />
        </div>
      ))}
    </div>
  );
}
