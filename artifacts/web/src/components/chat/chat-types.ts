/**
 * Shared UI types for the chat page.
 */
import type { TickerEntry } from "./tool-ticker";
import type { SurfacedProspect } from "./prospect-card";
import type { ChatSubAgent } from "@/lib/chat-sse";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Tool calls made during this assistant turn (assistant messages only). */
  ticker?: TickerEntry[];
  /** Prospects surfaced during this assistant turn. */
  prospects?: SurfacedProspect[];
  /** Specialist sub-agents consulted during this assistant turn. */
  subAgents?: ChatSubAgent[];
}

/** The streaming assistant turn currently in progress. */
export interface InflightTurn {
  text: string;
  ticker: TickerEntry[];
  prospects: SurfacedProspect[];
  subAgents: ChatSubAgent[];
}
