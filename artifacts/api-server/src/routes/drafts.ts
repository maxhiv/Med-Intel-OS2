import { Router, type IRouter } from "express";
import { eq, and, desc, sql, type SQL } from "drizzle-orm";
import { db, outreachDrafts, draftEdits, type OutreachDraft } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { pushApprovedDraftToCrm } from "../services/crmPush";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const STATUSES = ["pending", "approved", "sent", "skipped", "rejected"] as const;
type DraftStatus = (typeof STATUSES)[number];

router.get("/drafts", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const status = req.query.status as DraftStatus | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const conds: SQL[] = [eq(outreachDrafts.accountId, accountId)];
  if (status && STATUSES.includes(status)) {
    conds.push(eq(outreachDrafts.status, status));
  }
  const where = and(...conds);

  const items = await db
    .select()
    .from(outreachDrafts)
    .where(where)
    .orderBy(desc(outreachDrafts.generatedAt))
    .limit(limit)
    .offset(offset);
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(where);
  res.json({ data: items, total: c, limit, offset });
});

router.get("/drafts/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [d] = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(eq(outreachDrafts.id, id), eq(outreachDrafts.accountId, accountId)),
    );
  if (!d) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(d);
});

async function recordEdits(
  draftId: string,
  before: OutreachDraft,
  patch: Record<string, unknown>,
  userId: string | undefined,
) {
  for (const [field, value] of Object.entries(patch)) {
    const oldVal = (before as unknown as Record<string, unknown>)[field];
    if (oldVal !== value) {
      await db.insert(draftEdits).values({
        draftId,
        editedBy: userId ?? null,
        fieldChanged: field,
        originalValue: oldVal == null ? null : String(oldVal),
        newValue: value == null ? null : String(value),
      });
    }
  }
}

router.patch("/drafts/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [before] = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(eq(outreachDrafts.id, id), eq(outreachDrafts.accountId, accountId)),
    );
  if (!before) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const patch: Record<string, unknown> = {};
  for (const k of ["subject", "body", "linkedinNote", "linkedinMessage"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no_fields" });
    return;
  }
  await recordEdits(id, before, patch, req.currentUser?.id);
  const [updated] = await db
    .update(outreachDrafts)
    .set(patch)
    .where(eq(outreachDrafts.id, id))
    .returning();
  res.json(updated);
});

router.post("/drafts/:id/approve", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [updated] = await db
    .update(outreachDrafts)
    .set({
      status: "approved",
      reviewedBy: req.currentUser?.id ?? null,
      reviewedAt: new Date(),
    })
    .where(
      and(eq(outreachDrafts.id, id), eq(outreachDrafts.accountId, accountId)),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Trust-critical: at approval time, immediately push the draft to the
  // configured CRM as a pending artifact (stubbed adapter). The draft stays
  // "approved" until the rep actually sends it from the CRM. We swallow
  // CRM errors so the approval itself is durable; the daily batch will retry.
  let crmDraftId: string | null = null;
  let crmSyncedAt: Date | null = null;
  try {
    const r = await pushApprovedDraftToCrm(updated);
    crmDraftId = r.crmDraftId;
    crmSyncedAt = r.syncedAt;
    // Audit the push as a draft edit
    await db.insert(draftEdits).values({
      draftId: id,
      editedBy: req.currentUser?.id ?? null,
      fieldChanged: "crmSyncedAt",
      originalValue: null,
      newValue: r.syncedAt.toISOString(),
    });
  } catch (err) {
    logger.warn({ err, draftId: id }, "CRM push at approval failed; will retry in batch");
  }

  res.json({ ...updated, crmDraftId: crmDraftId ?? updated.crmDraftId, crmSyncedAt: crmSyncedAt ?? updated.crmSyncedAt });
});

router.post("/drafts/:id/reject", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const reason = (req.body?.reason as string | undefined) ?? null;
  const [updated] = await db
    .update(outreachDrafts)
    .set({
      status: "rejected",
      rejectionReason: reason,
      reviewedBy: req.currentUser?.id ?? null,
      reviewedAt: new Date(),
    })
    .where(
      and(eq(outreachDrafts.id, id), eq(outreachDrafts.accountId, accountId)),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

export default router;
