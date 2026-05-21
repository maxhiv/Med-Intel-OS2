/**
 * SessionSidebar — the rep's chat sessions, grouped by recency, with a
 * "New chat" button. Active session highlighted.
 */
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare } from "lucide-react";
import type { ChatSessionSummary } from "@/lib/chat-sse";

function groupByDate(sessions: ChatSessionSummary[]): Record<string, ChatSessionSummary[]> {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const groups: Record<string, ChatSessionSummary[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    Older: [],
  };
  for (const s of sessions) {
    const t = new Date(s.lastMessageAt || s.createdAt);
    if (t >= today) groups.Today.push(s);
    else if (t >= yesterday) groups.Yesterday.push(s);
    else if (t >= weekAgo) groups["This week"].push(s);
    else groups.Older.push(s);
  }
  return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
}

export function SessionSidebar({
  sessions,
  activeId,
  onNew,
  onSelect,
}: {
  sessions: ChatSessionSummary[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  const grouped = groupByDate(sessions);
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <Button className="w-full" size="sm" onClick={onNew}>
          <Plus className="h-4 w-4 mr-1" /> New chat
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground text-center">
            No sessions yet. Click “New chat” to start.
          </div>
        ) : (
          Object.entries(grouped).map(([label, group]) => (
            <div key={label} className="py-2">
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {label}
              </div>
              <ul>
                {group.map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => onSelect(s.id)}
                      className={`w-full text-left px-3 py-2 text-sm flex items-start gap-2 hover:bg-accent transition-colors ${
                        s.id === activeId ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{s.title || "Untitled chat"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
