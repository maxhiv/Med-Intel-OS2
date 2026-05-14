/**
 * CON-filing alert notifier.
 *
 * Walks every active `con_alert_subscriptions` row, finds new `con_filings`
 * created since the subscription's last processed filing, and emits one
 * in-app notification per (subscription, filing) match. The unique index
 * `uniq_con_alert_notif_sub_filing` makes the insert idempotent under
 * concurrent runs.
 *
 * Watermarking is by `con_filings.(created_at, id)` of the most recent
 * filing this subscription has already been notified about — NOT by the
 * notification's own timestamp. That keeps progress correct even when a
 * single ingestion run produces more than `BATCH_SIZE` matching filings:
 * we page through ascending until the backlog is exhausted.
 *
 * Slack integration: Slack alerts fire ONLY for `pending` and `under_review`
 * filings — the early-stage statuses that represent actionable sales signals.
 * Alerts are capped at 1 message per 30 seconds per webhook target via a
 * module-level queue: messages that arrive while the window is open are
 * buffered and delivered after the window expires, not dropped.
 *
 * Two independent Slack paths:
 *  - Per-account webhook (from `accounts.settings.slackWebhookUrl`) — fires
 *    when a subscription matched a pending/under_review filing.
 *  - Platform webhook (SLACK_CON_WEBHOOK_URL env var) — fires for the same
 *    statuses, scoped to the `__platform__` rate-limit key. Does NOT fall
 *    back from the account path; the two paths are strictly independent to
 *    avoid double-sending to the same URL.
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  accounts,
  conAlertSubscriptions,
  conAlertNotifications,
  conFilings,
  type ConAlertSubscription,
} from "@workspace/db";
import { looksApproved } from "./conFilingsIngestor";
import { logger } from "../lib/logger";

export interface ConAlertNotifyResult {
  subscriptionsChecked: number;
  notificationsCreated: number;
  errors: number;
  slackMessagesSent: number;
}

const STATUS_EMOJI: Record<string, string> = {
  approved:     "✅",
  denied:       "🚫",
  under_review: "🔍",
  pending:      "📋",
};
const STATUS_LABEL: Record<string, string> = {
  approved:     "Approved",
  denied:       "Denied",
  under_review: "Under Review",
  pending:      "Pending",
};

// ---------------------------------------------------------------------------
// Rate-limited, queued Slack dispatch.
// One queue entry per target (accountId or "__platform__").
// Messages that arrive inside the 30-second window are buffered and scheduled
// for delivery after the window expires — they are never silently dropped.
// ---------------------------------------------------------------------------
const SLACK_MIN_INTERVAL_MS = 30_000;
const slackLastSent = new Map<string, number>();
const slackQueue = new Map<string, Array<{ webhookUrl: string; payload: string }>>();

function flushSlackQueue(targetKey: string): void {
  const queue = slackQueue.get(targetKey);
  if (!queue || queue.length === 0) return;
  const item = queue.shift()!;
  slackLastSent.set(targetKey, Date.now());
  fetch(item.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: item.payload,
    signal: AbortSignal.timeout(5_000),
  }).catch((err: unknown) => {
    logger.warn({ err, targetKey }, "conAlertNotifier: queued slack webhook failed");
  });
  if (queue.length > 0) {
    setTimeout(() => flushSlackQueue(targetKey), SLACK_MIN_INTERVAL_MS);
  }
}

function enqueueSlack(
  targetKey: string,
  webhookUrl: string,
  payload: string,
): "sent" | "queued" {
  const now = Date.now();
  const last = slackLastSent.get(targetKey) ?? 0;
  const elapsed = now - last;

  if (elapsed >= SLACK_MIN_INTERVAL_MS) {
    slackLastSent.set(targetKey, now);
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(5_000),
    }).catch((err: unknown) => {
      logger.warn({ err, targetKey }, "conAlertNotifier: slack webhook failed");
    });
    return "sent";
  }

  if (!slackQueue.has(targetKey)) slackQueue.set(targetKey, []);
  slackQueue.get(targetKey)!.push({ webhookUrl, payload });
  const delay = SLACK_MIN_INTERVAL_MS - elapsed;
  setTimeout(() => flushSlackQueue(targetKey), delay);
  logger.debug({ targetKey, delay }, "conAlertNotifier: slack message queued for deferred delivery");
  return "queued";
}

function buildSlackPayload(filing: {
  state: string;
  applicantName: string | null;
  equipmentType: string | null;
  modality: string | null;
  statusNormalized: NormalizedStatus;
}): string {
  const sn = filing.statusNormalized ?? "pending";
  const equipment = filing.equipmentType || filing.modality || "Equipment";
  const text =
    `${STATUS_EMOJI[sn] ?? "📋"} *New CON filing — ${filing.state}* | ${STATUS_LABEL[sn] ?? sn}\n` +
    `*Applicant:* ${filing.applicantName || "Unknown"}\n` +
    `*Equipment:* ${equipment}`;
  return JSON.stringify({ text });
}

// ---------------------------------------------------------------------------
// Per-account webhook lookup (NO env fallback — env is a separate path).
// ---------------------------------------------------------------------------
const accountWebhookCache = new Map<string, string | null>();

async function getAccountSlackWebhookUrl(accountId: string): Promise<string | null> {
  if (accountWebhookCache.has(accountId)) {
    return accountWebhookCache.get(accountId) ?? null;
  }
  try {
    const [row] = await db
      .select({ settings: accounts.settings })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    const settings = (row?.settings as Record<string, unknown>) ?? {};
    const raw = typeof settings.slackWebhookUrl === "string" ? settings.slackWebhookUrl.trim() : "";
    const url = raw.startsWith("https://hooks.slack.com/") ? raw : null;
    accountWebhookCache.set(accountId, url);
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status normalisation.
// ---------------------------------------------------------------------------
type NormalizedStatus = "approved" | "denied" | "under_review" | "pending" | null;

function normalizeStatus(raw: string | null | undefined): NormalizedStatus {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (looksApproved(raw)) return "approved";
  if (/deni|disapprov|reject|withdr|not approv|void|revok/.test(s)) return "denied";
  if (/review|under.?review|in.?review|pending review/.test(s)) return "under_review";
  return "pending";
}

function matches(
  sub: ConAlertSubscription,
  filing: {
    state: string;
    modality: string | null;
    statusNormalized: NormalizedStatus;
  },
): boolean {
  if (sub.states.length > 0 && !sub.states.includes(filing.state)) return false;
  if (sub.modalities.length > 0) {
    if (!filing.modality || !sub.modalities.includes(filing.modality)) {
      return false;
    }
  }
  const sf = sub.statusFilter;
  if (sf === "approved" && filing.statusNormalized !== "approved") return false;
  if (sf === "denied" && filing.statusNormalized !== "denied") return false;
  if (sf === "under_review" && filing.statusNormalized !== "under_review") return false;
  if (sf === "pending" && filing.statusNormalized !== "pending") return false;
  if (sf === "filed" && filing.statusNormalized === "approved") return false;
  return true;
}

const BATCH_SIZE = 500;
const MAX_BATCHES_PER_SUB = 20;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export async function notifyConAlerts(): Promise<ConAlertNotifyResult> {
  accountWebhookCache.clear();

  const result: ConAlertNotifyResult = {
    subscriptionsChecked: 0,
    notificationsCreated: 0,
    errors: 0,
    slackMessagesSent: 0,
  };

  const subs = await db
    .select()
    .from(conAlertSubscriptions)
    .where(eq(conAlertSubscriptions.isActive, true));

  const envWebhook = (process.env.SLACK_CON_WEBHOOK_URL ?? "").trim();
  const platformWebhook = envWebhook.startsWith("https://hooks.slack.com/") ? envWebhook : null;

  for (const sub of subs) {
    result.subscriptionsChecked += 1;
    try {
      let cursorTs: Date = sub.lastProcessedAt ?? sub.createdAt ?? new Date(0);
      let cursorId: string = sub.lastProcessedId ?? ZERO_UUID;

      const accountWebhook = await getAccountSlackWebhookUrl(sub.accountId);

      for (let batch = 0; batch < MAX_BATCHES_PER_SUB; batch += 1) {
        const filings = await db
          .select({
            id: conFilings.id,
            state: conFilings.state,
            modality: conFilings.modality,
            status: conFilings.status,
            applicantName: conFilings.applicantName,
            equipmentType: conFilings.equipmentType,
            facilityId: conFilings.facilityId,
            createdAt: conFilings.createdAt,
          })
          .from(conFilings)
          .where(
            or(
              sql`${conFilings.createdAt} > ${cursorTs}`,
              and(
                eq(conFilings.createdAt, cursorTs),
                sql`${conFilings.id} > ${cursorId}`,
              ),
            ),
          )
          .orderBy(asc(conFilings.createdAt), asc(conFilings.id))
          .limit(BATCH_SIZE);

        if (filings.length === 0) break;

        const candidates = filings
          .map((f) => ({ ...f, statusNormalized: normalizeStatus(f.status) }))
          .filter((f) =>
            matches(sub, {
              state: f.state,
              modality: f.modality,
              statusNormalized: f.statusNormalized,
            }),
          );

        if (candidates.length > 0) {
          const inserted = await db
            .insert(conAlertNotifications)
            .values(
              candidates.map((f) => ({
                accountId: sub.accountId,
                userId: sub.userId,
                subscriptionId: sub.id,
                conFilingId: f.id,
                state: f.state,
                modality: f.modality,
                statusNormalized: f.statusNormalized,
                applicantName: f.applicantName,
                facilityId: f.facilityId,
              })),
            )
            .onConflictDoNothing({
              target: [
                conAlertNotifications.subscriptionId,
                conAlertNotifications.conFilingId,
              ],
            })
            .returning({ id: conAlertNotifications.id });

          result.notificationsCreated += inserted.length;

          if (inserted.length > 0) {
            const firstMatch = candidates[0];
            const isEarlyStage =
              firstMatch.statusNormalized === "pending" ||
              firstMatch.statusNormalized === "under_review";

            // Per-account Slack: only for pending/under_review.
            if (accountWebhook && isEarlyStage) {
              const outcome = enqueueSlack(
                sub.accountId,
                accountWebhook,
                buildSlackPayload(firstMatch),
              );
              if (outcome === "sent") result.slackMessagesSent += 1;
            }

            // Platform Slack: only for pending/under_review; strictly
            // independent of the account path — fires even when the account
            // has no webhook, but never to the same URL as the account webhook
            // in the same pass (avoids double-send to a shared endpoint).
            if (
              platformWebhook &&
              isEarlyStage &&
              platformWebhook !== accountWebhook
            ) {
              const outcome = enqueueSlack(
                "__platform__",
                platformWebhook,
                buildSlackPayload(firstMatch),
              );
              if (outcome === "sent") result.slackMessagesSent += 1;
            }
          }
        }

        const last = filings[filings.length - 1];
        cursorTs = last.createdAt ?? cursorTs;
        cursorId = last.id;

        await db
          .update(conAlertSubscriptions)
          .set({ lastProcessedAt: cursorTs, lastProcessedId: cursorId })
          .where(eq(conAlertSubscriptions.id, sub.id));

        if (filings.length < BATCH_SIZE) break;
      }
    } catch (err) {
      logger.warn(
        { err, subscriptionId: sub.id, userId: sub.userId },
        "con alert notifier: subscription failed",
      );
      result.errors += 1;
    }
  }

  return result;
}

/**
 * Helper for routes — the count of unread alerts for a user, used to power
 * the settings page badge / navbar badge.
 */
export async function unreadConAlertCount(userId: string): Promise<number> {
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(conAlertNotifications)
    .where(
      and(
        eq(conAlertNotifications.userId, userId),
        isNull(conAlertNotifications.readAt),
      ),
    );
  return c ?? 0;
}

export const __testables = { matches, normalizeStatus, STATUS_EMOJI, STATUS_LABEL };
