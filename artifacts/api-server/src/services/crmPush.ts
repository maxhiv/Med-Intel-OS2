/**
 * CRM push service. Sends a single approved draft to its sub-account's
 * configured CRM via a real adapter (GoHighLevel, HubSpot, Salesforce).
 *
 * Each push records a `sync_items` row inside a `sync_batches` audit envelope
 * so the Batches page can surface success/failure per draft and offer retry.
 *
 * IMPORTANT: This does NOT send the email. The rep reviews the artifact (a
 * task in the CRM, with the draft body) and clicks send there. The draft
 * status remains "approved" until the rep actually sends it.
 */
import { and, eq } from "drizzle-orm";
import {
  db,
  outreachDrafts,
  contactEnrollments,
  campaignContacts,
  campaigns,
  syncBatches,
  syncItems,
  subAccounts,
  facilities,
  facilityContacts,
  crmContactsMap,
  type OutreachDraft,
  type SubAccount,
  type Contact,
  type Facility,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { getCrmAdapter, CrmAdapterError, type CrmType } from "./crmAdapters";

export interface CrmPushResult {
  crmDraftId: string;
  crmContactId: string;
  crmType: string;
  syncedAt: Date;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the sub-account that owns a given draft via:
 *   draft.enrollmentId -> contactEnrollments.campaignContactId
 *   -> campaignContacts.campaignId -> campaigns.subAccountId
 */
export async function resolveSubAccountForDraft(
  draft: Pick<OutreachDraft, "id" | "accountId" | "enrollmentId">,
): Promise<SubAccount | null> {
  if (draft.enrollmentId) {
    const [row] = await db
      .select({ sub: subAccounts })
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
    if (row) return row.sub;
  }
  // Legacy/manual draft: fall back to the tenant's first active sub-account
  // so the audit trail still lands somewhere observable.
  const [sub] = await db
    .select()
    .from(subAccounts)
    .where(
      and(
        eq(subAccounts.accountId, draft.accountId),
        eq(subAccounts.isActive, true),
      ),
    )
    .limit(1);
  return sub ?? null;
}

async function loadContactAndFacility(
  draft: OutreachDraft,
): Promise<{ contact: Contact; facility: Facility }> {
  const [contact] = await db
    .select()
    .from(facilityContacts)
    .where(eq(facilityContacts.id, draft.contactId));
  const [facility] = await db
    .select()
    .from(facilities)
    .where(eq(facilities.id, draft.facilityId));
  if (!contact || !facility) {
    throw new CrmAdapterError({
      code: "draft_missing_contact_or_facility",
      message: "Draft references a contact or facility that no longer exists",
      retryable: false,
    });
  }
  return { contact, facility };
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof CrmAdapterError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      status: err.status ?? null,
      details:
        err.details === undefined
          ? null
          : safeStringifyForJson(err.details),
    };
  }
  if (err instanceof Error) {
    return { code: "unknown_error", message: err.message, retryable: true };
  }
  return { code: "unknown_error", message: String(err), retryable: true };
}

function safeStringifyForJson(v: unknown): unknown {
  try {
    // Round-trip through JSON to drop circular refs / functions.
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

/**
 * Push a single approved draft inside an existing sync_batch envelope.
 * Inserts a sync_items row with success/failure detail and updates the draft
 * + crm_contacts_map on success. Returns whether the push succeeded.
 */
export async function pushDraftWithinBatch(
  draft: OutreachDraft,
  subAccount: SubAccount,
  batchId: string,
  attempt = 0,
): Promise<{ ok: true; result: CrmPushResult } | { ok: false; retryable: boolean; error: ReturnType<typeof serializeError> }> {
  const crmType = (subAccount.crmType ?? "other") as CrmType | "other";
  const adapter = getCrmAdapter(crmType);
  if (!adapter) {
    const err = serializeError(
      new CrmAdapterError({
        code: "unsupported_crm_type",
        message: `No adapter registered for CRM type "${crmType}"`,
        retryable: false,
      }),
    );
    await db.insert(syncItems).values({
      batchId,
      accountId: draft.accountId,
      entityType: "outreach_draft",
      localId: draft.id,
      crmType: subAccount.crmType ?? null,
      status: "failed",
      errorMessage: err.message as string,
      crmResponse: err,
      retryCount: attempt,
    });
    return { ok: false, retryable: false, error: err };
  }

  try {
    const { contact, facility } = await loadContactAndFacility(draft);
    const outcome = await adapter.push({ draft, contact, facility, subAccount });
    const now = new Date();

    await db
      .update(outreachDrafts)
      .set({ crmSyncedAt: now, crmDraftId: outcome.crmDraftId })
      .where(eq(outreachDrafts.id, draft.id));

    // Maintain the contact-id mapping so future syncs reuse the same record.
    await db
      .insert(crmContactsMap)
      .values({
        accountId: draft.accountId,
        localContactId: draft.contactId,
        crmType: adapter.type,
        crmContactId: outcome.crmContactId,
        crmCompanyId: outcome.crmCompanyId ?? null,
      })
      .onConflictDoUpdate({
        target: [crmContactsMap.accountId, crmContactsMap.localContactId, crmContactsMap.crmType],
        set: { crmContactId: outcome.crmContactId, lastSyncedAt: now },
      });

    await db.insert(syncItems).values({
      batchId,
      accountId: draft.accountId,
      entityType: "outreach_draft",
      localId: draft.id,
      crmType: adapter.type,
      crmId: outcome.crmDraftId,
      status: "complete",
      crmResponse: { crmContactId: outcome.crmContactId, crmDraftId: outcome.crmDraftId },
      pushedAt: now,
      retryCount: attempt,
    });

    return {
      ok: true,
      result: {
        crmDraftId: outcome.crmDraftId,
        crmContactId: outcome.crmContactId,
        crmType: adapter.type,
        syncedAt: now,
      },
    };
  } catch (err) {
    const serialized = serializeError(err);
    await db.insert(syncItems).values({
      batchId,
      accountId: draft.accountId,
      entityType: "outreach_draft",
      localId: draft.id,
      crmType: adapter.type,
      status: "failed",
      errorMessage: serialized.message as string,
      crmResponse: serialized,
      retryCount: attempt,
    });
    logger.warn(
      { draftId: draft.id, crmType: adapter.type, err: serialized },
      "CRM push failed",
    );
    return { ok: false, retryable: Boolean(serialized.retryable), error: serialized };
  }
}

/**
 * One-shot push for the approval path. Wraps a single draft in its own
 * sync_batches envelope, runs the adapter, and returns the push result.
 * Idempotent: a draft already synced returns its existing record.
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
      crmContactId: "",
      crmType: "other",
      syncedAt: draft.crmSyncedAt,
    };
  }

  const sub = await resolveSubAccountForDraft(draft);
  if (!sub) {
    throw new CrmAdapterError({
      code: "no_sub_account",
      message: "No sub-account configured for this draft's tenant",
      retryable: false,
    });
  }

  const startedAt = new Date();
  const [batch] = await db
    .insert(syncBatches)
    .values({
      accountId: draft.accountId,
      subAccountId: sub.id,
      crmType: (sub.crmType ?? "other"),
      batchDate: todayDateString(),
      targetCount: 1,
      pushedCount: 0,
      failedCount: 0,
      status: "running",
      startedAt,
    })
    .returning();

  const res = await pushDraftWithinBatch(draft, sub, batch.id, 0);
  const completedAt = new Date();

  if (res.ok) {
    await db
      .update(syncBatches)
      .set({
        pushedCount: 1,
        failedCount: 0,
        status: "complete",
        completedAt,
      })
      .where(eq(syncBatches.id, batch.id));
    return res.result;
  }

  await db
    .update(syncBatches)
    .set({
      pushedCount: 0,
      failedCount: 1,
      status: "failed",
      completedAt,
      errorLog: [res.error],
    })
    .where(eq(syncBatches.id, batch.id));

  // Surface the failure to the approval handler so it can decide whether to
  // log a warning (retryable) or bubble the error up.
  throw new CrmAdapterError({
    code: (res.error.code as string) ?? "crm_push_failed",
    message: (res.error.message as string) ?? "CRM push failed",
    retryable: Boolean(res.error.retryable),
    details: res.error.details,
  });
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
