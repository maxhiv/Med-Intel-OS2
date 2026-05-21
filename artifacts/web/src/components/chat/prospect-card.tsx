/**
 * ChatProspectCard — the inline card the agent surfaces when it persists an
 * opportunity to the Inbox during a chat turn. Links through to the full
 * Opportunity detail page.
 */
import { Link } from "wouter";
import { MapPin, ArrowRight } from "lucide-react";

export interface SurfacedProspect {
  opportunityId: string;
  summary: string;
}

export function ChatProspectCard({ prospect }: { prospect: SurfacedProspect }) {
  return (
    <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 bg-emerald-600 text-white rounded">
          Opportunity
        </span>
        <MapPin className="h-3.5 w-3.5 text-emerald-700" />
        <span className="text-xs text-emerald-700">Added to your Inbox</span>
      </div>
      <p className="mt-1.5 text-sm text-emerald-900">{prospect.summary}</p>
      <Link
        href={`/opportunities/${prospect.opportunityId}`}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-900"
      >
        View in Opportunity Inbox <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
