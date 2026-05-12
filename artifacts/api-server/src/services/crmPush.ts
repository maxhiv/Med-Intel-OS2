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
  contactEnrollments,
  campaignContacts,
  campaigns,
  syncBatches,
  subAccounts,
  type OutreachDraft,
} from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Resolve the sub-account that owns a given draft via:
 *   draft.enrollmentId -> contactEnrollments.campaignContactId
 *   -> campaignContacts.campaignId -> campaigns.subAccountId
 *
 * Returns null when the draft has no enrollment lineage (legacy/manual draft).
 */
export async function resolveSubAccountForDraft(
  draft: Pick<OutreachDraft, "id" | "accountId" | "enrollmentId">,
): Promise<{ id: string; crmType: string | null } | null> {
  if (!draft.enrollmentId) return null;
  const [row] = await db
    .select({ id: subAccounts.id, crmType: subAccounts.crmType })
    .from(contactEnrollments)
    .innerJoin(
      campaignContacts,
      eq(campaignContacts.id, contactEnrollments.campaignContactId),
    )
    .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
    .innerJoin(subAccounts, eq(subAccounts.id, campaigns.subAccountId))
    .where(
      and(
        eq(contactEnrollments.id, draft.enrollmentId),
        eq(subAccounts.accountId, draft.accountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

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

  // Resolve the sub-account from the draft's campaign lineage so the artifact
  // lands in the correct CRM destination for multi-sub-account tenants.
  type CrmType = NonNullable<(typeof subAccounts.crmType)["_"]["data"]>;
  let crmType: CrmType = "other";
  let subAccountId: string | null = null;
  const lineage = await resolveSubAccountForDraft(draft);
  if (lineage) {
    crmType = (lineage.crmType ?? "other") as CrmType;
    subAccountId = lineage.id;
  } else {
    // Legacy/manual draft with no enrollment lineage: fall back to the
    // tenant's first active sub-account so the audit trail is still recorded.
    const [sub] = await db
      .select({ id: subAccounts.id, crmType: subAccounts.crmType })
      .from(subAccounts)
      .where(
        and(
          eq(subAccounts.accountId, draft.accountId),
          eq(subAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (sub) {
      crmType = (sub.crmType ?? "other") as CrmType;
      subAccountId = sub.id;
    }
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
