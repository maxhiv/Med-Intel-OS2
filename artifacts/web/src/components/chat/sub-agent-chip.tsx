/**
 * SubAgentChip — renders one specialist sub-agent consultation inside the
 * main agent's response. The header carries the specialist's emoji + name and
 * a cost/latency footer; the body is the consultation answer.
 *
 * Colors are coded by category so a rep can pattern-match at a glance which
 * kind of expertise the agent reached for.
 */
import { AlertTriangle } from "lucide-react";
import type { ChatSubAgent } from "@/lib/chat-sse";

const CATEGORY_STYLE: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  mbse: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-900", accent: "text-blue-600" },
  strategy: { bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-900", accent: "text-indigo-600" },
  revenue: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-900", accent: "text-emerald-600" },
  quality: { bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-900", accent: "text-rose-600" },
  healthit: { bg: "bg-cyan-50", border: "border-cyan-200", text: "text-cyan-900", accent: "text-cyan-600" },
  operations: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-900", accent: "text-amber-600" },
  payer: { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-900", accent: "text-violet-600" },
  default: { bg: "bg-muted", border: "border-border", text: "text-foreground", accent: "text-muted-foreground" },
};

export function SubAgentChip({ consult }: { consult: ChatSubAgent }) {
  const style = CATEGORY_STYLE[consult.category] ?? CATEGORY_STYLE.default;
  const failed = consult.status !== "success";
  const latency =
    consult.latencyMs > 0 ? `${(consult.latencyMs / 1000).toFixed(1)}s` : null;
  const cost = consult.costUsd > 0 ? `$${consult.costUsd.toFixed(3)}` : null;

  return (
    <div className={`${style.bg} ${style.border} border rounded-lg overflow-hidden`}>
      <div className={`flex items-center justify-between gap-2 px-3 py-2 ${style.border} border-b`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base shrink-0">{consult.emoji ?? "🧠"}</span>
          <span className={`text-xs font-semibold truncate ${style.text}`}>
            {consult.displayName}
          </span>
          {failed && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
        </div>
        {(latency || cost) && (
          <div className={`text-[10px] font-mono shrink-0 ${style.accent}`}>
            {[latency, cost].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <div className={`px-3 py-2.5 text-sm whitespace-pre-wrap ${style.text}`}>
        {consult.response}
      </div>
    </div>
  );
}
