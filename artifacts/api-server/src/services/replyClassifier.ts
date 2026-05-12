/**
 * Background classifier for inbound CRM replies.
 *
 * The webhook pipeline persists every inbound CRM event as a `reply_events`
 * row with `aiClassification` left null. This service finds reply rows that
 * haven't been classified yet, asks Anthropic to bucket the message into one
 * of a small fixed set of categories, writes the result back to the row, and
 * (for unsubscribe / not-interested replies) flips the contact's sequence
 * enrollment to a stop state so we don't keep emailing someone who's said no.
 *
 * Run via cron (`classifyReplies` job) and also fired best-effort right after
 * a webhook ingest so qualified replies surface on the Drafts page within
 * seconds rather than waiting on the next tick.
 */
import { and, eq, isNull, isNotNull, inArray, desc, or, ilike } from "drizzle-orm";
import {
  db,
  replyEvents,
  outreachDrafts,
  contactEnrollments,
  withRLS,
} from "@workspace/db";
import { ai, ANTHROPIC_MODEL } from "../lib/anthropic";
import { logger } from "../lib/logger";

export const REPLY_CLASSES = [
  "interested",
  "not_interested",
  "objection",
  "out_of_office",
  "unsubscribe",
  "wrong_person",
  "unknown",
] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

const STOP_CLASSES: ReadonlySet<ReplyClass> = new Set([
  "unsubscribe",
  "not_interested",
]);

function extractBody(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const r = raw as Record<string, unknown>;
  // Try common reply body field names across GHL / HubSpot / Salesforce.
  const candidates = [
    r.body,
    r.text,
    r.message,
    r.messageBody,
    r.replyBody,
    r.bodyPlainText,
    r.bodyText,
    r.htmlBody,
    r.html,
    r.subject,
    (r.message as { body?: unknown } | undefined)?.body,
    (r.email as { body?: unknown } | undefined)?.body,
    (r.email as { text?: unknown } | undefined)?.text,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function classifyReplyText(text: string): Promise<ReplyClass> {
  const cleaned = stripHtml(text).slice(0, 2000);
  if (!cleaned) return "unknown";

  const prompt = `Classify the following email reply from a hospital buyer into exactly one of these categories:
- interested: shows curiosity, wants more info, asks to schedule a meeting, sends a positive response
- not_interested: politely or firmly declines, says no thanks, not a fit
- objection: raises a concern (price, timing, vendor, contract) but not an outright no
- out_of_office: automated OOO / vacation / parental leave reply
- unsubscribe: asks to be removed, opted out, "stop emailing me", "remove from list"
- wrong_person: says they are not the right contact, refers you to someone else
- unknown: anything else, including ambiguous one-word replies

Reply text:
"""
${cleaned}
"""

Respond with JSON only: {"classification": "<one of the categories above>"}.`;

  const completion = await ai.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: prompt }],
  });
  const out = completion.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) return "unknown";
  try {
    const parsed = JSON.parse(match[0]) as { classification?: string };
    const c = (parsed.classification ?? "").toLowerCase().trim();
    if ((REPLY_CLASSES as readonly string[]).includes(c)) return c as ReplyClass;
  } catch {
    /* fall through */
  }
  return "unknown";
}

/**
 * Pause / mark the affected sequence enrollment when the reply means the
 * contact has opted out. We look up the enrollment via the originating draft.
 */
async function applyStopAction(
  draftId: string,
  classification: ReplyClass,
): Promise<void> {
  if (!STOP_CLASSES.has(classification)) return;
  const [d] = await db
    .select({ enrollmentId: outreachDrafts.enrollmentId })
    .from(outreachDrafts)
    .where(eq(outreachDrafts.id, draftId))
    .limit(1);
  if (!d?.enrollmentId) return;
  const newStatus = classification === "unsubscribe" ? "unsubscribed" : "paused";
  await db
    .update(contactEnrollments)
    .set({ status: newStatus, completedAt: new Date() })
    .where(eq(contactEnrollments.id, d.enrollmentId));
}

export interface ClassifyResult {
  examined: number;
  classified: number;
  stopped: number;
  failed: number;
}

/**
 * Classify up to `limit` un-classified reply events for a single account.
 * All database work runs inside `withRLS(accountId, ...)` so unfiltered
 * reads/writes against `reply_events`, `outreach_drafts`, and
 * `contact_enrollments` cannot leak into another tenant's rows. Re-entrant
 * under an existing RLS scope (e.g. when invoked from an authenticated
 * request that the middleware already wrapped).
 */
export async function classifyPendingRepliesForAccount(
  accountId: string,
  limit = 25,
): Promise<ClassifyResult> {
  return withRLS(accountId, async () => {
    // Filter to reply-shaped event types in SQL so opens / bounces / task
    // events (which also live in `reply_events` with a null
    // `aiClassification`) can never starve real replies out of the
    // processing window.
    const replies = await db
      .select({
        id: replyEvents.id,
        draftId: replyEvents.draftId,
        eventType: replyEvents.eventType,
        rawPayload: replyEvents.rawPayload,
      })
      .from(replyEvents)
      .where(
        and(
          isNull(replyEvents.aiClassification),
          isNotNull(replyEvents.draftId),
          or(
            ilike(replyEvents.eventType, "%reply%"),
            ilike(replyEvents.eventType, "%inboundmessage%"),
            ilike(replyEvents.eventType, "%inbound_message%"),
          ),
        ),
      )
      .orderBy(desc(replyEvents.receivedAt))
      .limit(limit);
    let classified = 0;
    let stopped = 0;
    let failed = 0;

    for (const row of replies) {
      const body = extractBody(row.rawPayload);
      if (!body) {
        await db
          .update(replyEvents)
          .set({ aiClassification: "unknown" })
          .where(eq(replyEvents.id, row.id));
        classified += 1;
        continue;
      }
      try {
        const cls = await classifyReplyText(body);
        await db
          .update(replyEvents)
          .set({ aiClassification: cls })
          .where(eq(replyEvents.id, row.id));
        classified += 1;
        if (row.draftId && STOP_CLASSES.has(cls)) {
          await applyStopAction(row.draftId, cls);
          stopped += 1;
        }
      } catch (err) {
        failed += 1;
        logger.warn(
          { err, replyEventId: row.id },
          "reply classification failed",
        );
      }
    }

    return { examined: replies.length, classified, stopped, failed };
  });
}

/**
 * Cross-account fan-out for the reply-classifier cron job. Enumerates the
 * distinct accounts with un-classified reply events and opens one
 * RLS-scoped transaction per account via `classifyPendingRepliesForAccount`
 * — never one global cross-tenant transaction. The discovery query reads
 * `reply_events.account_id` directly (not RLS-scoped from outside, but
 * only the id list is exposed; per-account work is what gates content).
 *
 * `limit` is interpreted as a per-account cap so a single noisy tenant
 * cannot starve the others out of a tick.
 */
export async function classifyPendingReplies(
  limit = 25,
): Promise<ClassifyResult> {
  const accountRows = await db
    .selectDistinct({ accountId: replyEvents.accountId })
    .from(replyEvents)
    .where(
      and(
        isNull(replyEvents.aiClassification),
        isNotNull(replyEvents.draftId),
        or(
          ilike(replyEvents.eventType, "%reply%"),
          ilike(replyEvents.eventType, "%inboundmessage%"),
          ilike(replyEvents.eventType, "%inbound_message%"),
        ),
      ),
    );

  const totals: ClassifyResult = {
    examined: 0,
    classified: 0,
    stopped: 0,
    failed: 0,
  };
  for (const { accountId } of accountRows) {
    if (!accountId) continue;
    const r = await classifyPendingRepliesForAccount(accountId, limit);
    totals.examined += r.examined;
    totals.classified += r.classified;
    totals.stopped += r.stopped;
    totals.failed += r.failed;
  }
  return totals;
}

/**
 * Latest non-null classification per draft, scoped to one account.
 * Used by the drafts list endpoint to surface the badge in the UI.
 */
export async function latestClassificationsForDrafts(
  accountId: string,
  draftIds: string[],
): Promise<Record<string, string>> {
  if (draftIds.length === 0) return {};
  const rows = await db
    .select({
      draftId: replyEvents.draftId,
      cls: replyEvents.aiClassification,
      receivedAt: replyEvents.receivedAt,
    })
    .from(replyEvents)
    .where(
      and(
        eq(replyEvents.accountId, accountId),
        inArray(replyEvents.draftId, draftIds),
        isNotNull(replyEvents.aiClassification),
      ),
    )
    .orderBy(desc(replyEvents.receivedAt));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.draftId && !out[r.draftId] && r.cls) out[r.draftId] = r.cls;
  }
  return out;
}