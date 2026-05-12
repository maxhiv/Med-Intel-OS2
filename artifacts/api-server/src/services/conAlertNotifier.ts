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
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
// (kept) types from drizzle
import {
  db,
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
}

function normalizeStatus(raw: string | null | undefined): "approved" | "filed" | null {
  if (!raw) return null;
  // Reuse the ingestor's `looksApproved` so we share the same negative-aware
  // semantics (disapproved / denied / withdrawn / not approved → false).
  return looksApproved(raw) ? "approved" : "filed";
}

function matches(
  sub: ConAlertSubscription,
  filing: {
    state: string;
    modality: string | null;
    statusNormalized: "approved" | "filed" | null;
  },
): boolean {
  if (sub.states.length > 0 && !sub.states.includes(filing.state)) return false;
  if (sub.modalities.length > 0) {
    if (!filing.modality || !sub.modalities.includes(filing.modality)) {
      return false;
    }
  }
  if (sub.statusFilter === "approved" && filing.statusNormalized !== "approved") {
    return false;
  }
  if (sub.statusFilter === "filed" && filing.statusNormalized !== "filed") {
    return false;
  }
  return true;
}

const BATCH_SIZE = 500;
// Hard cap on pagination per subscription per run as a safety valve so a
// runaway backlog can't pin a single subscription for an unbounded time;
// remaining work picks up on the next tick.
const MAX_BATCHES_PER_SUB = 20;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export async function notifyConAlerts(): Promise<ConAlertNotifyResult> {
  const result: ConAlertNotifyResult = {
    subscriptionsChecked: 0,
    notificationsCreated: 0,
    errors: 0,
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

      for (let batch = 0; batch < MAX_BATCHES_PER_SUB; batch += 1) {
        const filings = await db
          .select({
            id: conFilings.id,
            state: conFilings.state,
            modality: conFilings.modality,
            status: conFilings.status,
            applicantName: conFilings.applicantName,
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

export const __testables = { matches, normalizeStatus };
