/**
 * Daily batch runner — for each active sub-account, creates a sync_batch
 * row (stubbed CRM push). Real CRM adapters (HubSpot, Salesforce, GHL,
 * Pipedrive, etc.) live behind this; here we just record the intent.
 */
import { and, eq, sql, isNull, asc } from "drizzle-orm";
import {
  db,
  subAccounts,
  syncBatches,
  outreachDrafts,
  contactEnrollments,
  campaignContacts,
  campaigns,
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
    // Scope unsynced drafts to THIS sub-account by joining through the
    // enrollment -> campaign_contact -> campaign chain. Without this join the
    // loop would arbitrarily consume drafts that belong to other sub-accounts
    // and record syncBatches against the wrong destination.
    const toPush = await db
      .select({ id: outreachDrafts.id })
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

    const target = toPush.length;
    if (target === 0) continue;

    await db
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
      });
    batches += 1;
    pushed += target;

    // Stubbed CRM push: record that the draft was delivered to the CRM as a
    // pending artifact (e.g. a draft email/task on the rep's timeline).
    // Status remains "approved" — only an actual rep send transitions to "sent".
    const now = new Date();
    for (const d of toPush) {
      await db
        .update(outreachDrafts)
        .set({ crmSyncedAt: now, crmDraftId: `stub_${d.id.slice(0, 8)}` })
        .where(eq(outreachDrafts.id, d.id));
    }
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
