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
 * single ingestion run produces more than `BATCH_SIZE` matching filings.
 *
 * Slack integration: alerts fire ONLY for `pending` and `under_review`
 * filings, one per newly-inserted notification. Rate is capped to
 * 1 message/30 s per target key via a true serialized queue:
 *  - Messages that arrive while the window is open are buffered, not dropped.
 *  - Only ONE timer is ever active per target key at a time.
 *  - The timer re-checks elapsed time at delivery to guard against clock skew.
 *
 * Two independent Slack paths (no URL-fallback cross-contamination):
 *  - Per-account webhook  — `accounts.settings.slackWebhookUrl`
 *  - Platform webhook     — `SLACK_CON_WEBHOOK_URL` env var
 *  If both resolve to the same URL the platform path is suppressed for that
 *  pass to prevent double-posting.
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
// Serialized Slack queue — one active timer per target key.
//
// Invariant: `slackTimerActive.has(key)` is true IFF a setTimeout is
// outstanding for that key. Only one timer is ever scheduled at a time;
// the timer re-checks elapsed time at delivery to guard against races.
// ---------------------------------------------------------------------------
const SLACK_MIN_INTERVAL_MS = 30_000;
const slackLastSent  = new Map<string, number>();
const slackQueue     = new Map<string, Array<{ webhookUrl: string; payload: string }>>();
const slackTimerActive = new Map<string, true>();

function dispatchSlackNow(targetKey: string, webhookUrl: string, payload: string): void {
  slackLastSent.set(targetKey, Date.now());
  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  }).catch((err: unknown) => {
    logger.warn({ err, targetKey }, "conAlertNotifier: slack webhook failed");
  });
}

function scheduleFlush(targetKey: string, delayMs: number): void {
  slackTimerActive.set(targetKey, true);
  setTimeout(() => {
    slackTimerActive.delete(targetKey);

    const queue = slackQueue.get(targetKey);
    if (!queue || queue.length === 0) return;

    // Re-check elapsed time at delivery (guards against clock skew / multiple
    // enqueues that would have shortened the originally-computed delay).
    const now = Date.now();
    const last = slackLastSent.get(targetKey) ?? 0;
    const elapsed = now - last;

    if (elapsed < SLACK_MIN_INTERVAL_MS) {
      // Still too early — re-queue with the remaining window.
      scheduleFlush(targetKey, SLACK_MIN_INTERVAL_MS - elapsed);
      return;
    }

    const item = queue.shift()!;
    dispatchSlackNow(targetKey, item.webhookUrl, item.payload);

    // If more items remain, schedule next flush after the full interval.
    if (queue.length > 0) {
      scheduleFlush(targetKey, SLACK_MIN_INTERVAL_MS);
    }
  }, delayMs);
}

/**
 * Enqueue a Slack message for `targetKey`.  If the rate-limit window has
 * expired the message is sent immediately; otherwise it is buffered and a
 * single deferred timer is (re-)used to drain the queue.
 *
 * Returns "sent" only when the message is dispatched synchronously here;
 * "queued" when it is deferred.
 */
function enqueueSlack(
  targetKey: string,
  webhookUrl: string,
  payload: string,
): "sent" | "queued" {
  const now = Date.now();
  const last = slackLastSent.get(targetKey) ?? 0;

  if (now - last >= SLACK_MIN_INTERVAL_MS) {
    dispatchSlackNow(targetKey, webhookUrl, payload);
    return "sent";
  }

  // Buffer the message.
  if (!slackQueue.has(targetKey)) slackQueue.set(targetKey, []);
  slackQueue.get(targetKey)!.push({ webhookUrl, payload });

  // Schedule exactly one timer per target key — do not stack timers.
  if (!slackTimerActive.has(targetKey)) {
    scheduleFlush(targetKey, SLACK_MIN_INTERVAL_MS - (now - last));
  }

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
// Per-account webhook lookup (no env-var fallback — env is a separate path).
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
  filing: { state: string; modality: string | null; statusNormalized: NormalizedStatus },
): boolean {
  if (sub.states.length > 0 && !sub.states.includes(filing.state)) return false;
  if (sub.modalities.length > 0) {
    if (!filing.modality || !sub.modalities.includes(filing.modality)) return false;
  }
  const sf = sub.statusFilter;
  if (sf === "approved"     && filing.statusNormalized !== "approved")     return false;
  if (sf === "denied"       && filing.statusNormalized !== "denied")       return false;
  if (sf === "under_review" && filing.statusNormalized !== "under_review") return false;
  if (sf === "pending"      && filing.statusNormalized !== "pending")      return false;
  if (sf === "filed"        && filing.statusNormalized === "approved")     return false;
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
            .returning({
              id: conAlertNotifications.id,
              conFilingId: conAlertNotifications.conFilingId,
            });

          result.notificationsCreated += inserted.length;

          if (inserted.length > 0) {
            // Build a set of filing IDs that were genuinely new (not conflicts).
            const insertedFilingIds = new Set(inserted.map((r) => r.conFilingId));

            // Emit one Slack alert per newly-inserted pending/under_review notification.
            for (const match of candidates) {
              if (!insertedFilingIds.has(match.id)) continue;
              const isEarlyStage =
                match.statusNormalized === "pending" ||
                match.statusNormalized === "under_review";
              if (!isEarlyStage) continue;

              const payload = buildSlackPayload(match);

              if (accountWebhook) {
                const outcome = enqueueSlack(sub.accountId, accountWebhook, payload);
                if (outcome === "sent") result.slackMessagesSent += 1;
              }

              // Platform path: independent of account path; suppressed when
              // both point to the same URL to avoid double-posting.
              if (platformWebhook && platformWebhook !== accountWebhook) {
                const outcome = enqueueSlack("__platform__", platformWebhook, payload);
                if (outcome === "sent") result.slackMessagesSent += 1;
              }
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
