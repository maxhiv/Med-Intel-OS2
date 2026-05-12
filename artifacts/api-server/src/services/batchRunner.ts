/**
 * Daily batch runner — for each active sub-account, opens a sync_batches
 * envelope, pushes each approved draft through the configured CRM adapter,
 * retries transient failures, and records aggregate counts + per-item
 * outcomes (sync_items) so the Batches page can surface failures.
 */
import { and, eq, sql, isNull, asc } from "drizzle-orm";
import {
  db,
  subAccounts,
  syncBatches,
  syncItems,
  outreachDrafts,
  contactEnrollments,
  campaignContacts,
  campaigns,
  withRLS,
  type SubAccount,
} from "@workspace/db";
import { pushDraftWithinBatch } from "./crmPush";
import { logger } from "../lib/logger";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function runBatchForSub(
  accountId: string,
  sub: SubAccount,
): Promise<{ pushed: number; failed: number; batchId: string | null }> {
  const toPush = await db
    .select({ draft: outreachDrafts })
    .from(outreachDrafts)
    .innerJoin(
      contactEnrollments,
      eq(contactEnrollments.id, outreachDrafts.enrollmentId),
    )
    .innerJoin(
      campaignContacts,
      eq(campaignContacts.id, contactEnrollments.campaignContactId),
    )
    .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
    .where(
      and(
        eq(outreachDrafts.accountId, accountId),
        eq(outreachDrafts.status, "approved"),
        isNull(outreachDrafts.crmSyncedAt),
        eq(campaigns.subAccountId, sub.id),
      ),
    )
    .orderBy(asc(outreachDrafts.generatedAt))
    .limit(sub.batchSizeDaily ?? 10);

  if (toPush.length === 0) {
    return { pushed: 0, failed: 0, batchId: null };
  }

  const startedAt = new Date();
  const [batch] = await db
    .insert(syncBatches)
    .values({
      accountId,
      subAccountId: sub.id,
      crmType: sub.crmType ?? "other",
      batchDate: todayDateString(),
      targetCount: toPush.length,
      pushedCount: 0,
      failedCount: 0,
      status: "running",
      startedAt,
    })
    .returning();

  let pushed = 0;
  let failed = 0;
  const errorLog: unknown[] = [];

  for (const { draft } of toPush) {
    let attempt = 0;
    while (true) {
      const res = await pushDraftWithinBatch(draft, sub, batch.id, attempt);
      if (res.ok) {
        pushed += 1;
        break;
      }
      if (!res.retryable || attempt >= MAX_RETRIES) {
        failed += 1;
        errorLog.push({ draftId: draft.id, attempts: attempt + 1, ...res.error });
        break;
      }
      attempt += 1;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
  }

  const completedAt = new Date();
  const status = failed === 0 ? "complete" : pushed === 0 ? "failed" : "partial";
  await db
    .update(syncBatches)
    .set({
      pushedCount: pushed,
      failedCount: failed,
      status,
      completedAt,
      errorLog,
    })
    .where(eq(syncBatches.id, batch.id));

  return { pushed, failed, batchId: batch.id };
}

export async function runDailyBatchesForAccount(
  accountId: string,
): Promise<{ batches: number; pushed: number; failed: number }> {
  // All work runs inside a per-account RLS transaction so a forgotten
  // `WHERE account_id` filter inside the runner cannot leak into another
  // tenant's batches/drafts. Re-entrant when the API middleware already
  // opened an RLS scope for the same account.
  return withRLS(accountId, async () => {
    const subs = await db
      .select()
      .from(subAccounts)
      .where(
        and(
          eq(subAccounts.accountId, accountId),
          eq(subAccounts.isActive, true),
        ),
      );

    let batches = 0;
    let pushed = 0;
    let failed = 0;
    for (const sub of subs) {
      const r = await runBatchForSub(accountId, sub);
      if (r.batchId) batches += 1;
      pushed += r.pushed;
      failed += r.failed;
    }
    return { batches, pushed, failed };
  });
}

export async function runAllAccounts(): Promise<{
  accounts: number;
  batches: number;
  pushed: number;
  failed: number;
}> {
  // Discovery query reads `sub_accounts`, which is not RLS-scoped, so we
  // run it without an RLS context. Each per-account batch then opens its
  // own `withRLS` scope (via runDailyBatchesForAccount) — no global
  // cross-tenant transaction.
  const accountIds = await db
    .select({ accountId: subAccounts.accountId })
    .from(subAccounts)
    .where(eq(subAccounts.isActive, true))
    .groupBy(subAccounts.accountId);

  let total = 0;
  let totalPushed = 0;
  let totalFailed = 0;
  for (const { accountId } of accountIds) {
    const r = await runDailyBatchesForAccount(accountId);
    total += r.batches;
    totalPushed += r.pushed;
    totalFailed += r.failed;
  }
  return { accounts: accountIds.length, batches: total, pushed: totalPushed, failed: totalFailed };
}

/**
 * Retry only the failed sync_items inside an existing batch. Used by the
 * Batches page "Retry failures" button. Replays the failed drafts through the
 * adapter and updates pushed/failed counts in place.
 */
export async function retryFailedItemsInBatch(
  accountId: string,
  batchId: string,
): Promise<{ retried: number; pushed: number; failed: number }> {
  // Wrap in withRLS so even when invoked outside the API request lifecycle
  // (cron, scripts, future background workers) the unfiltered sync_items
  // and outreach_drafts queries below can only see this account's rows.
  return withRLS(accountId, async () => {
  const [batch] = await db
    .select()
    .from(syncBatches)
    .where(and(eq(syncBatches.id, batchId), eq(syncBatches.accountId, accountId)));
  if (!batch) {
    throw new Error("batch_not_found");
  }
  const [sub] = await db
    .select()
    .from(subAccounts)
    .where(eq(subAccounts.id, batch.subAccountId));
  if (!sub) {
    throw new Error("sub_account_not_found");
  }

  const failedItems = await db
    .select()
    .from(syncItems)
    .where(and(eq(syncItems.batchId, batchId), eq(syncItems.status, "failed")));

  if (failedItems.length === 0) {
    return { retried: 0, pushed: 0, failed: 0 };
  }

  await db
    .update(syncBatches)
    .set({ status: "running" })
    .where(eq(syncBatches.id, batchId));

  let pushedDelta = 0;
  let stillFailed = 0;
  const newErrors: unknown[] = [];

  for (const item of failedItems) {
    const [draft] = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.id, item.localId));
    if (!draft) {
      stillFailed += 1;
      newErrors.push({ draftId: item.localId, code: "draft_not_found" });
      continue;
    }
    // Mark the previous failed item as superseded so each retry stays as its
    // own audit row (sync_items append-only).
    await db
      .update(syncItems)
      .set({ status: "superseded" })
      .where(eq(syncItems.id, item.id));

    const attempt = (item.retryCount ?? 0) + 1;
    let lastResult: Awaited<ReturnType<typeof pushDraftWithinBatch>> | null = null;
    let local = attempt;
    while (true) {
      lastResult = await pushDraftWithinBatch(draft, sub, batchId, local);
      if (lastResult.ok || !lastResult.retryable || local >= attempt + MAX_RETRIES) {
        break;
      }
      local += 1;
      await sleep(RETRY_BASE_MS * Math.pow(2, local - attempt - 1));
    }
    if (lastResult?.ok) {
      pushedDelta += 1;
    } else if (lastResult) {
      stillFailed += 1;
      newErrors.push({ draftId: draft.id, attempts: local + 1, ...lastResult.error });
    }
  }

  const newPushed = (batch.pushedCount ?? 0) + pushedDelta;
  const newFailed = stillFailed;
  const status =
    newFailed === 0 ? "complete" : newPushed === 0 ? "failed" : "partial";
  const mergedErrors = [
    ...(Array.isArray(batch.errorLog) ? (batch.errorLog as unknown[]) : []),
    ...newErrors,
  ];
  await db
    .update(syncBatches)
    .set({
      pushedCount: newPushed,
      failedCount: newFailed,
      status,
      completedAt: new Date(),
      errorLog: mergedErrors,
    })
    .where(eq(syncBatches.id, batchId));

  logger.info(
    { batchId, retried: failedItems.length, pushedDelta, stillFailed },
    "batch retry complete",
  );
  return { retried: failedItems.length, pushed: pushedDelta, failed: stillFailed };
  });
}

export { sql };
