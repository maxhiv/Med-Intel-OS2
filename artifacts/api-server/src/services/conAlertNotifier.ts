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
 * Slack integration: if the account has `settings.slackWebhookUrl` set, a
 * rate-limited fire-and-forget POST is sent for each newly-matched filing.
 * Rate is capped to 1 message per 30 seconds per account to avoid flooding.
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

// Slack rate-limiter: tracks last-sent timestamp per accountId so we never
// exceed 1 message per 30 seconds per account (fire-and-forget).
const SLACK_MIN_INTERVAL_MS = 30_000;
const slackLastSent = new Map<string, number>();

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

async function maybeSendSlack(
  accountId: string,
  webhookUrl: string,
  filing: {
    state: string;
    applicantName: string | null;
    equipmentType: string | null;
    modality: string | null;
    statusNormalized: NormalizedStatus;
  },
): Promise<boolean> {
  const now = Date.now();
  const last = slackLastSent.get(accountId) ?? 0;
  if (now - last < SLACK_MIN_INTERVAL_MS) {
    logger.debug({ accountId }, "conAlertNotifier: slack rate-limited, skipping");
    return false;
  }
  slackLastSent.set(accountId, now);

  const sn = filing.statusNormalized ?? "pending";
  const statusEmoji = STATUS_EMOJI[sn] ?? "📋";
  const label = STATUS_LABEL[sn] ?? sn;
  const equipment = filing.equipmentType || filing.modality || "Equipment";

  const text =
    `${statusEmoji} *New CON filing — ${filing.state}* | ${label}\n` +
    `*Applicant:* ${filing.applicantName || "Unknown"}\n` +
    `*Equipment:* ${equipment}`;

  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  }).catch((err: unknown) => {
    logger.warn({ err, accountId }, "conAlertNotifier: slack webhook failed");
  });

  return true;
}

// Cache webhook URLs per run so we don't hit the DB per subscription.
const accountWebhookCache = new Map<string, string | null>();

async function getSlackWebhookUrl(accountId: string): Promise<string | null> {
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
    const url = typeof settings.slackWebhookUrl === "string" ? settings.slackWebhookUrl.trim() : null;
    const accountUrl = url && url.startsWith("https://hooks.slack.com/") ? url : null;
    // Fall back to platform-wide env var when the account has no per-account webhook.
    const envFallback = process.env.SLACK_CON_WEBHOOK_URL?.trim() ?? "";
    const envUrl = envFallback.startsWith("https://hooks.slack.com/") ? envFallback : null;
    const valid = accountUrl ?? envUrl ?? null;
    accountWebhookCache.set(accountId, valid);
    return valid;
  } catch {
    return null;
  }
}

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
  // Map legacy statusFilter values as well as the new four-way taxonomy.
  const sf = sub.statusFilter;
  if (sf === "approved" && filing.statusNormalized !== "approved") return false;
  if (sf === "denied" && filing.statusNormalized !== "denied") return false;
  if (sf === "under_review" && filing.statusNormalized !== "under_review") return false;
  if (sf === "pending" && filing.statusNormalized !== "pending") return false;
  // Legacy: "filed" covers anything that isn't approved.
  if (sf === "filed" && filing.statusNormalized === "approved") return false;
  return true;
}

const BATCH_SIZE = 500;
// Hard cap on pagination per subscription per run as a safety valve so a
// runaway backlog can't pin a single subscription for an unbounded time;
// remaining work picks up on the next tick.
const MAX_BATCHES_PER_SUB = 20;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export async function notifyConAlerts(): Promise<ConAlertNotifyResult> {
  // Reset per-run cache so account settings changes take effect.
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

  for (const sub of subs) {
    result.subscriptionsChecked += 1;
    try {
      // Cursor = persistent (last_processed_at, last_processed_id) on the
      // subscription itself. Advances on every batch even when no rows match,
      // so a subscription with sparse matches still moves forward through the
      // backlog instead of re-scanning the same prefix every run.
      let cursorTs: Date = sub.lastProcessedAt ?? sub.createdAt ?? new Date(0);
      let cursorId: string = sub.lastProcessedId ?? ZERO_UUID;

      const webhookUrl = await getSlackWebhookUrl(sub.accountId);

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
          // (created_at, id) > (cursorTs, cursorId) — strict tuple ordering so
          // we don't re-emit the cursor row and don't skip ties.
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

          // Send a rate-limited Slack notification for the first match per batch.
          // Per-account webhook fires for any subscribed status; platform env
          // webhook (SLACK_CON_WEBHOOK_URL) fires specifically for pending and
          // under_review filings to surface early-stage opportunities.
          if (inserted.length > 0) {
            const firstMatch = candidates[0];
            if (webhookUrl) {
              const sent = await maybeSendSlack(sub.accountId, webhookUrl, firstMatch);
              if (sent) result.slackMessagesSent += 1;
            }
            // Platform-level alert for pending/under_review regardless of subscription.
            const envWebhook = process.env.SLACK_CON_WEBHOOK_URL?.trim();
            if (
              envWebhook &&
              envWebhook.startsWith("https://hooks.slack.com/") &&
              (firstMatch.statusNormalized === "pending" || firstMatch.statusNormalized === "under_review")
            ) {
              const sent = await maybeSendSlack("__platform__", envWebhook, firstMatch);
              if (sent) result.slackMessagesSent += 1;
            }
          }
        }

        // Advance the cursor to the last filing in this batch — even if it
        // didn't match the subscription's filters — so we don't re-scan it.
        const last = filings[filings.length - 1];
        cursorTs = last.createdAt ?? cursorTs;
        cursorId = last.id;

        // Persist progress after every batch so a crash mid-run doesn't
        // force a full backlog re-scan on restart.
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
