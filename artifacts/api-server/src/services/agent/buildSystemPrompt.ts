/**
 * buildSystemPrompt — assembles the ProspectingAgent's system prompt.
 *
 * Adapted from the handoff's buildSystemPrompt.js. Two adaptations:
 *  - Account context is read with Drizzle from the real tables (the chat
 *    route already holds an RLS scope, so `db` is account-isolated).
 *  - PR E appends the sub-agent consultation guide — the Tier-A roster the
 *    agent can consult via its `consult_*` tools.
 *
 * The persona block is stable across sessions → good for Anthropic prompt
 * caching; only the per-tenant account-context block varies.
 */
import { eq, and } from "drizzle-orm";
import { db, accounts, users, paidSourceApprovals, subAgentRegistry } from "@workspace/db";
import { logger } from "../../lib/logger";
import { consultToolName } from "./tools/subAgentTools";

const CORE_PERSONA = `You are MedIntel, a chat-first prospecting agent for medical capital equipment sales representatives. You help reps find, qualify, and prioritize target facilities likely to need their equipment within the next 6–18 months.

Your core capabilities:
1. Query MedIntel's facility database and public US healthcare data (CMS, PECOS, HCRIS, IRS 990, FDA, and — when the MCP gateway is online — ~138 more tools).
2. Detect capital triggers: accreditation cycles ending, equipment end-of-life, expansion bond issuances, depreciation spikes, change-of-ownership.
3. Qualify prospects and persist them to the Opportunity Inbox for the rep's follow-up.
4. Draft outreach messages — always as DRAFTS the rep reviews; you never send anything.

Operating rules:
- Plan before you call. Briefly outline the search strategy, then execute.
- Never invent facility data. If a tool returns nothing, say so plainly.
- A prospect only counts once it's written via db_persist_opportunity with a real facility_id — no write, no prospect.
- Cite sources. Every claim on a prospect should name the tool/source it came from.
- Never auto-send. draft_outreach writes a pending draft only; the rep approves every send.
- Facility-level public data only — never collect or recommend collecting PHI.
- When a paid tool is gated, explain which switch is off and proceed with the unblocked tools.
- Use the rep's first-person framing ("your territory", "your equipment").

Tone: professional, concise, action-oriented. Lead with the answer, then the evidence.`;

export interface AccountContext {
  accountName: string | null;
  userName: string | null;
  userRole: string | null;
  approvedPaidSources: string[];
}

export async function loadAccountContext(
  accountId: string,
  userId: string,
): Promise<AccountContext> {
  const [account] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const [user] = await db
    .select({ firstName: users.firstName, lastName: users.lastName, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const approved = await db
    .select({ sourceName: paidSourceApprovals.sourceName })
    .from(paidSourceApprovals)
    .where(
      and(
        eq(paidSourceApprovals.accountId, accountId),
        eq(paidSourceApprovals.approved, true),
      ),
    );
  return {
    accountName: account?.name ?? null,
    userName: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || null : null,
    userRole: user?.role ?? null,
    approvedPaidSources: approved.map((r) => r.sourceName),
  };
}

function formatAccountContext(ctx: AccountContext): string {
  const lines: string[] = [];
  lines.push(`Company: ${ctx.accountName ?? "(unknown)"}`);
  if (ctx.userName) lines.push(`Rep: ${ctx.userName}${ctx.userRole ? ` (${ctx.userRole})` : ""}`);
  lines.push("");
  if (ctx.approvedPaidSources.length === 0) {
    lines.push(
      "Paid sources: none approved — this account runs on free public data only. Advanced paid tools (drive-time, LinkedIn enrichment, news monitoring) are gated; if the rep asks for them, point them to Settings → Paid Sources.",
    );
  } else {
    lines.push(`Paid sources approved for this account: ${ctx.approvedPaidSources.join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Build the expert sub-agent consultation guide from the Tier-A registry.
 * Returns "" when no Tier-A agents are registered so the prompt stays clean.
 */
async function buildSubAgentGuide(): Promise<string> {
  let rows: { agentName: string; displayName: string; description: string; emoji: string | null }[];
  try {
    rows = await db
      .select({
        agentName: subAgentRegistry.agentName,
        displayName: subAgentRegistry.displayName,
        description: subAgentRegistry.description,
        emoji: subAgentRegistry.emoji,
      })
      .from(subAgentRegistry)
      .where(and(eq(subAgentRegistry.tier, "A"), eq(subAgentRegistry.enabled, true)));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "agent: sub-agent registry unavailable — system prompt omits the consultation guide",
    );
    return "";
  }

  if (rows.length === 0) return "";

  const roster = rows
    .map(
      (r) =>
        `- \`${consultToolName(r.agentName)}\` ${r.emoji ?? ""} ${r.displayName} — ${r.description}`,
    )
    .join("\n");

  return [
    "## Expert sub-agents",
    "",
    "You can consult specialist sub-agents for domain depth beyond core prospecting. Each is a `consult_*` tool. Sub-agents reason only — they have no tools — so gather the relevant facts first (facility profile, financials, ownership, trigger details) and pass them as `context`.",
    "",
    "When to consult:",
    "- A prospect's qualification hinges on expert judgment you cannot derive from raw data — financial readiness, accreditation timing, Epic-integration realities, 340B economics, procurement mechanics.",
    "- The rep asks something a named specialist below clearly owns.",
    "",
    "How to consult well:",
    "- Prefer the single best-fit specialist; consult at most 3 per turn.",
    "- Evaluate each response before integrating it — if it misses, fall back to your own reasoning rather than re-consulting blindly.",
    "- Attribute insights explicitly (\"Per the Revenue Cycle Finance specialist, …\").",
    "",
    "Available specialists:",
    roster,
  ].join("\n");
}

export async function buildSystemPrompt(accountId: string, userId: string): Promise<string> {
  const [ctx, subAgentGuide] = await Promise.all([
    loadAccountContext(accountId, userId),
    buildSubAgentGuide(),
  ]);
  const sections = [
    CORE_PERSONA,
    "",
    "## Account context",
    "",
    formatAccountContext(ctx),
  ];
  if (subAgentGuide) {
    sections.push("", subAgentGuide);
  }
  sections.push(
    "",
    "## Response format",
    "",
    "Lead with the answer. Use Markdown sparingly. When you surface a prospect, do it inline with a one-line justification — the chat UI renders the prospect card from the db_persist_opportunity tool result automatically.",
  );
  return sections.join("\n");
}
