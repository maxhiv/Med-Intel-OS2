/**
 * Inbound CRM webhooks: opens, replies, bounces, and task-completion events
 * from each connected CRM are POSTed here. We verify the signature against
 * the per-sub-account shared secret, normalize the payload, persist a
 * `reply_events` row, and update the originating `outreach_drafts` row's
 * engagement timestamp.
 *
 * Public URL pattern (no auth — vendors call us):
 *     POST /api/webhooks/{ghl|hubspot|salesforce}/{subAccountId}
 *
 * Failures (bad signature, unknown contact, malformed body) are themselves
 * recorded as `reply_events` rows with `eventType = "webhook_error"` so they
 * surface in the Batches page's "Webhook ingest errors" panel.
 */
import { Router, type IRouter, type Request } from "express";
import { and, eq, desc, isNotNull } from "drizzle-orm";
import {
  db,
  subAccounts,
  crmContactsMap,
  outreachDrafts,
  replyEvents,
  type SubAccount,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { parseEvents, verifySignature } from "../services/webhookParsers";
import type { CrmType } from "../services/crmAdapters";
import { classifyPendingRepliesForAccount } from "../services/replyClassifier";
import { recomputeEngagementForAccountFacility } from "../services/signalScorer";

const router: IRouter = Router();

const SUPPORTED: CrmType[] = ["ghl", "hubspot", "salesforce"];

function isCrmType(v: string): v is CrmType {
  return (SUPPORTED as readonly string[]).includes(v);
}

interface WithRawBody extends Request {
  rawBody?: Buffer;
}

async function recordWebhookError(opts: {
  accountId: string | null;
  crm: CrmType;
  reason: string;
  detail: unknown;
  crmContactId?: string | null;
}): Promise<void> {
  if (!opts.accountId) return; // can't insert without tenant scope
  try {
    await db.insert(replyEvents).values({
      accountId: opts.accountId,
      crmType: opts.crm,
      crmContactId: opts.crmContactId ?? null,
      eventType: "webhook_error",
      rawPayload: { reason: opts.reason, detail: opts.detail },
    });
  } catch (err) {
    logger.warn({ err }, "failed to persist webhook_error row");
  }
}

router.post("/webhooks/:crm/:subAccountId", async (req: WithRawBody, res) => {
  const crmParam = String(req.params.crm).toLowerCase();
  const subAccountId = String(req.params.subAccountId);
  if (!isCrmType(crmParam)) {
    res.status(404).json({ error: "unknown_crm" });
    return;
  }
  const crm = crmParam;

  // Resolve the sub-account so we know which tenant + secret to verify against.
  let sub: SubAccount | undefined;
  try {
    [sub] = await db
      .select()
      .from(subAccounts)
      .where(eq(subAccounts.id, subAccountId))
      .limit(1);
  } catch (err) {
    logger.error({ err, subAccountId }, "webhook sub-account lookup failed");
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!sub) {
    res.status(404).json({ error: "unknown_sub_account" });
    return;
  }
  if (sub.crmType && sub.crmType !== crm) {
    // The URL CRM must match the sub-account's configured CRM type so we
    // reject obvious misconfiguration before doing crypto work.
    res.status(400).json({ error: "crm_mismatch" });
    return;
  }

  const creds = (sub.crmCredentials ?? {}) as { webhookSecret?: string };
  const secret = creds.webhookSecret ?? "";

  const rawBody: Buffer =
    req.rawBody && req.rawBody.length > 0
      ? req.rawBody
      : Buffer.from(JSON.stringify(req.body ?? {}), "utf8");

  const verify = verifySignature(crm, secret, {
    originalUrl: req.originalUrl,
    method: req.method,
    protocol: req.protocol,
    host: req.get("host") ?? "",
    rawBody,
    headers: req.headers,
  });
  if (!verify.ok) {
    await recordWebhookError({
      accountId: sub.accountId,
      crm,
      reason: verify.reason ?? "signature_invalid",
      detail: { headers: pickHeaderHints(req.headers) },
    });
    res.status(401).json({ error: "signature_invalid", reason: verify.reason });
    return;
  }

  let events;
  try {
    events = parseEvents(crm, req.body);
  } catch (err) {
    await recordWebhookError({
      accountId: sub.accountId,
      crm,
      reason: "parse_failed",
      detail: { message: (err as Error).message },
    });
    res.status(400).json({ error: "parse_failed" });
    return;
  }

  let processed = 0;
  let unmatched = 0;
  for (const e of events) {
    try {
      const matched = await processEvent(crm, sub.accountId, e);
      if (matched) processed += 1;
      else unmatched += 1;
    } catch (err) {
      logger.warn({ err, crm, subAccountId }, "webhook event processing failed");
      await recordWebhookError({
        accountId: sub.accountId,
        crm,
        reason: "process_failed",
        detail: { message: (err as Error).message, eventType: e.eventType },
        crmContactId: e.crmContactId,
      });
    }
  }

  // Best-effort: kick off a classification pass so qualified replies show up
  // on the Drafts page without waiting for the next cron tick. The cron job
  // remains the source of truth — failures here are logged and ignored.
  if (processed > 0) {
    void classifyPendingRepliesForAccount(sub.accountId, 10).catch((err) =>
      logger.warn({ err }, "post-webhook reply classification failed"),
    );
  }

  res.json({
    ok: true,
    received: events.length,
    processed,
    unmatched,
  });
});

/**
 * Persist a single normalized event. Returns true when the event was matched
 * to a known contact (and, when applicable, to a draft); false when we wrote
 * the event but couldn't tie it back to a local row.
 */
async function processEvent(
  crm: CrmType,
  accountId: string,
  e: ReturnType<typeof parseEvents>[number],
): Promise<boolean> {
  // Look up the local contact for this event. Required for canonical mapping.
  let localContactId: string | null = null;
  if (e.crmContactId) {
    const [m] = await db
      .select()
      .from(crmContactsMap)
      .where(
        and(
          eq(crmContactsMap.accountId, accountId),
          eq(crmContactsMap.crmType, crm),
          eq(crmContactsMap.crmContactId, e.crmContactId),
        ),
      )
      .limit(1);
    if (m) localContactId = m.localContactId;
  }

  // Find the originating draft (by crmDraftId match first, then most recent
  // synced draft for the contact).
  let draftId: string | null = null;
  if (e.crmTaskId) {
    const [d] = await db
      .select({ id: outreachDrafts.id })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.accountId, accountId),
          eq(outreachDrafts.crmDraftId, e.crmTaskId),
        ),
      )
      .limit(1);
    if (d) draftId = d.id;
  }
  if (!draftId && localContactId) {
    const [d] = await db
      .select({ id: outreachDrafts.id })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.accountId, accountId),
          eq(outreachDrafts.contactId, localContactId),
          isNotNull(outreachDrafts.crmSyncedAt),
        ),
      )
      .orderBy(desc(outreachDrafts.crmSyncedAt))
      .limit(1);
    if (d) draftId = d.id;
  }

  await db.insert(replyEvents).values({
    accountId,
    draftId,
    crmType: crm,
    crmContactId: e.crmContactId,
    eventType: e.eventType,
    rawPayload: e.raw as object,
  });

  // Surface unmatched events in the Batches "ingest errors" panel so admins
  // can see when a CRM webhook arrives for a contact / task we don't know
  // about (usually means the local <-> CRM mapping is missing or stale).
  if (!localContactId) {
    await db.insert(replyEvents).values({
      accountId,
      crmType: crm,
      crmContactId: e.crmContactId,
      eventType: "webhook_error",
      rawPayload: {
        reason: "unknown_crm_contact",
        eventType: e.eventType,
        crmContactId: e.crmContactId,
        crmTaskId: e.crmTaskId,
      },
    });
  } else if (e.canonical !== "other" && !draftId) {
    await db.insert(replyEvents).values({
      accountId,
      crmType: crm,
      crmContactId: e.crmContactId,
      eventType: "webhook_error",
      rawPayload: {
        reason: "no_matching_draft",
        eventType: e.eventType,
        crmContactId: e.crmContactId,
        crmTaskId: e.crmTaskId,
      },
    });
  }

  // Stamp engagement timestamp on the draft for canonical events.
  let affectedFacilityId: string | null = null;
  if (draftId) {
    const ts = e.occurredAt ?? new Date();
    if (e.canonical === "opened") {
      await db
        .update(outreachDrafts)
        .set({ openedAt: ts })
        .where(eq(outreachDrafts.id, draftId));
    } else if (e.canonical === "replied") {
      await db
        .update(outreachDrafts)
        .set({ repliedAt: ts, status: "sent" })
        .where(eq(outreachDrafts.id, draftId));
    } else if (e.canonical === "bounced" || e.canonical === "unsubscribed") {
      // Unsubscribes are persisted on `bouncedAt` so they flow through the
      // same negative-engagement path as hard bounces; the original event
      // type is preserved on the `reply_events` row above.
      await db
        .update(outreachDrafts)
        .set({ bouncedAt: ts })
        .where(eq(outreachDrafts.id, draftId));
    }

    // Recompute the parent facility's signal score so the daily pick list
    // reflects the new engagement signal immediately. Only triggered for
    // canonical engagement events; "other" / task-completed events don't
    // move the score.
    if (
      e.canonical === "opened" ||
      e.canonical === "replied" ||
      e.canonical === "bounced" ||
      e.canonical === "unsubscribed"
    ) {
      const [d] = await db
        .select({ facilityId: outreachDrafts.facilityId })
        .from(outreachDrafts)
        .where(eq(outreachDrafts.id, draftId))
        .limit(1);
      if (d?.facilityId) affectedFacilityId = d.facilityId;
    }
  }

  if (affectedFacilityId) {
    try {
      // Strictly tenant-scoped: only refresh engagement for THIS account's
      // view of the facility. Never touches other tenants' scores.
      await recomputeEngagementForAccountFacility(accountId, affectedFacilityId);
    } catch (err) {
      logger.warn(
        { err, accountId, facilityId: affectedFacilityId },
        "post-webhook engagement recompute failed",
      );
    }
  }

  return Boolean(localContactId);
}

function pickHeaderHints(headers: Request["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "x-wh-signature",
    "x-hubspot-signature",
    "x-hubspot-signature-v3",
    "x-hubspot-request-timestamp",
    "x-sf-signature",
    "user-agent",
  ]) {
    const v = headers[k];
    if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return out;
}

export default router;
