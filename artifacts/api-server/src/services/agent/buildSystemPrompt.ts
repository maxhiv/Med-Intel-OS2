/**
 * buildSystemPrompt — assembles the ProspectingAgent's system prompt.
 *
 * Adapted from the handoff's buildSystemPrompt.js. Two adaptations:
 *  - Account context is read with Drizzle from the real tables (the chat
 *    route already holds an RLS scope, so `db` is account-isolated).
 *  - The sub-agent consultation guide is OMITTED in PR C — sub-agents land
 *    in PR E. When PR E wires SubAgentInvoker in, it appends that section.
 *
 * The persona block is stable across sessions → good for Anthropic prompt
 * caching; only the per-tenant account-context block varies.
 */
import { eq, and } from "drizzle-orm";
import { db, accounts, users, paidSourceApprovals } from "@workspace/db";

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

export async function buildSystemPrompt(accountId: string, userId: string): Promise<string> {
  const ctx = await loadAccountContext(accountId, userId);
  return [
    CORE_PERSONA,
    "",
    "## Account context",
    "",
    formatAccountContext(ctx),
    "",
    "## Response format",
    "",
    "Lead with the answer. Use Markdown sparingly. When you surface a prospect, do it inline with a one-line justification — the chat UI renders the prospect card from the db_persist_opportunity tool result automatically.",
  ].join("\n");
}
