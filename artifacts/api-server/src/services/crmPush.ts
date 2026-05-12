/**
 * CRM push adapter (stubbed). Pushes a single approved draft to the
 * sub-account's configured CRM as a pending draft artifact (e.g. a Gmail
 * draft, a HubSpot task, a Salesforce activity). Real adapters live behind
 * this; this implementation just records the push intent so the trust-critical
 * approval -> CRM flow is observable end-to-end.
 *
 * IMPORTANT: This does NOT send the email. The rep reviews the artifact in
 * their CRM timeline and clicks send there. The draft's status remains
 * "approved" until the rep actually sends it.
 */
import { and, eq } from "drizzle-orm";
import {
  db,
  outreachDrafts,
  syncBatches,
  subAccounts,
  type OutreachDraft,
} from "@workspace/db";
import { logger } from "../lib/logger";

export interface CrmPushResult {
  crmDraftId: string;
  crmType: string;
  syncedAt: Date;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Push an approved draft to its sub-account's CRM as a pending artifact.
 * Idempotent: re-running on an already-synced draft returns the existing record.
 */
export async function pushApprovedDraftToCrm(
  draft: OutreachDraft,
): Promise<CrmPushResult> {
  if (draft.status !== "approved") {
    throw new Error("draft_must_be_approved_before_crm_push");
  }
  if (draft.crmSyncedAt && draft.crmDraftId) {
    return {
      crmDraftId: draft.crmDraftId,
      crmType: "other",
      syncedAt: draft.crmSyncedAt,
    };
  }

  // Resolve the sub-account's CRM type. For now we pick the first sub-account
  // for this tenant; richer routing (per-enrollment) is a follow-up.
  type CrmType = NonNullable<(typeof subAccounts.crmType)["_"]["data"]>;
  let crmType: CrmType = "other";
  let subAccountId: string | null = null;
  const [sub] = await db
    .select({ id: subAccounts.id, crmType: subAccounts.crmType })
    .from(subAccounts)
    .where(eq(subAccounts.accountId, draft.accountId))
    .limit(1);
  if (sub) {
    crmType = (sub.crmType ?? "other") as CrmType;
    subAccountId = sub.id;
  }

  const now = new Date();
  const crmDraftId = `${crmType}_${draft.id.slice(0, 8)}_${now.getTime()}`;

  await db
    .update(outreachDrafts)
    .set({ crmSyncedAt: now, crmDraftId })
    .where(eq(outreachDrafts.id, draft.id));

  // Audit row in syncBatches so admin observability picks it up.
  if (subAccountId) {
    await db.insert(syncBatches).values({
      accountId: draft.accountId,
      subAccountId,
      crmType,
      batchDate: todayDateString(),
      targetCount: 1,
      pushedCount: 1,
      failedCount: 0,
      status: "complete",
      startedAt: now,
      completedAt: now,
    });
  }

  logger.info(
    { draftId: draft.id, crmDraftId, crmType, accountId: draft.accountId },
    "draft pushed to CRM (stub)",
  );

  return { crmDraftId, crmType, syncedAt: now };
}

export async function findApprovedDraftsForAccount(
  accountId: string,
  limit: number,
) {
  return db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.accountId, accountId),
        eq(outreachDrafts.status, "approved"),
      ),
    )
    .limit(limit);
}
