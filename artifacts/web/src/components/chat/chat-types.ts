/**
 * Shared UI types for the chat page (PR D).
 */
import type { TickerEntry } from "./tool-ticker";
import type { SurfacedProspect } from "./prospect-card";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Tool calls made during this assistant turn (assistant messages only). */
  ticker?: TickerEntry[];
  /** Prospects surfaced during this assistant turn. */
  prospects?: SurfacedProspect[];
}

/** The streaming assistant turn currently in progress. */
export interface InflightTurn {
  text: string;
  ticker: TickerEntry[];
  prospects: SurfacedProspect[];
}
