/**
 * Daily batch runner — for each active sub-account, creates a sync_batch
 * row (stubbed CRM push). Real CRM adapters (HubSpot, Salesforce, GHL,
 * Pipedrive, etc.) live behind this; here we just record the intent.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  subAccounts,
  syncBatches,
  outreachDrafts,
} from "@workspace/db";

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runDailyBatchesForAccount(
  accountId: string,
): Promise<{ batches: number; pushed: number }> {
  const subs = await db
    .select()
    .from(subAccounts)
    .where(
      and(eq(subAccounts.accountId, accountId), eq(subAccounts.isActive, true)),
    );

  let batches = 0;
  let pushed = 0;
  const date = todayDateString();

  for (const sub of subs) {
    const approvedDrafts = await db
      .select({ id: outreachDrafts.id })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.accountId, accountId),
          eq(outreachDrafts.status, "approved"),
        ),
      )
      .limit(sub.batchSizeDaily ?? 10);

    const target = approvedDrafts.length;
    if (target === 0) continue;

    const [batch] = await db
      .insert(syncBatches)
      .values({
        accountId,
        subAccountId: sub.id,
        crmType: sub.crmType ?? "ghl",
        batchDate: date,
        targetCount: target,
        pushedCount: target,
        failedCount: 0,
        status: "complete",
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning();
    batches += 1;
    pushed += target;

    // Mark drafts as sent (stubbed CRM push)
    for (const d of approvedDrafts) {
      await db
        .update(outreachDrafts)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(outreachDrafts.id, d.id));
    }

    void batch;
  }

  return { batches, pushed };
}

export async function runAllAccounts(): Promise<{
  accounts: number;
  batches: number;
  pushed: number;
}> {
  const accountIds = await db
    .select({ accountId: subAccounts.accountId })
    .from(subAccounts)
    .where(eq(subAccounts.isActive, true))
    .groupBy(subAccounts.accountId);

  let total = 0;
  let totalPushed = 0;
  for (const { accountId } of accountIds) {
    const r = await runDailyBatchesForAccount(accountId);
    total += r.batches;
    totalPushed += r.pushed;
  }
  return { accounts: accountIds.length, batches: total, pushed: totalPushed };
}

export { sql };
