/**
 * ToolTicker — a one-line progress chip per tool the agent invokes during a
 * turn. Spinner while in flight; check / lightning / x once resolved.
 */
import { Loader2, Check, AlertTriangle } from "lucide-react";

export interface TickerEntry {
  id: string;
  tool: string;
  startedAt: number;
  completedAt?: number;
  latencyMs?: number;
  isError?: boolean;
}

function prettyToolName(tool: string): string {
  return tool.replace(/__|\./g, " / ").replace(/_/g, " ");
}

export function ToolTicker({ entries }: { entries: TickerEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1">
      {entries.map((e) => {
        const done = e.completedAt != null;
        const elapsed = done
          ? e.latencyMs != null
            ? `${(e.latencyMs / 1000).toFixed(1)}s`
            : null
          : `${Math.round((Date.now() - e.startedAt) / 1000)}s`;
        return (
          <div key={e.id} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            {!done && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
            {done && !e.isError && <Check className="h-3 w-3 text-emerald-600" />}
            {done && e.isError && <AlertTriangle className="h-3 w-3 text-red-600" />}
            <span className="font-medium text-foreground/80">{prettyToolName(e.tool)}</span>
            {elapsed && <span>({elapsed})</span>}
          </div>
        );
      })}
    </div>
  );
}
