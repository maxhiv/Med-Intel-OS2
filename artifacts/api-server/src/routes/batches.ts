import { Router, type IRouter } from "express";
import { eq, desc, and, asc, sql } from "drizzle-orm";
import { db, syncBatches, syncItems, replyEvents } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import {
  runDailyBatchesForAccount,
  runAllAccounts,
  retryFailedItemsInBatch,
} from "../services/batchRunner";

const router: IRouter = Router();

router.get("/batches", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const rows = await db
    .select()
    .from(syncBatches)
    .where(eq(syncBatches.accountId, accountId))
    .orderBy(desc(syncBatches.batchDate), desc(syncBatches.createdAt))
    .limit(limit);
  res.json(rows);
});

router.get("/batches/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [batch] = await db
    .select()
    .from(syncBatches)
    .where(and(eq(syncBatches.id, id), eq(syncBatches.accountId, accountId)));
  if (!batch) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const items = await db
    .select()
    .from(syncItems)
    .where(eq(syncItems.batchId, id))
    .orderBy(asc(syncItems.status), desc(syncItems.pushedAt));
  res.json({ batch, items });
});

router.post("/batches/:id/retry", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  try {
    const r = await retryFailedItemsInBatch(accountId, id);
    res.json(r);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "batch_not_found") {
      res.status(404).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

router.get("/webhook-events", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const errorsOnly = req.query.errorsOnly === "true" || req.query.errorsOnly === "1";
  const conds = [eq(replyEvents.accountId, accountId)];
  if (errorsOnly) conds.push(sql`${replyEvents.eventType} = 'webhook_error'`);
  const rows = await db
    .select()
    .from(replyEvents)
    .where(and(...conds))
    .orderBy(desc(replyEvents.receivedAt))
    .limit(limit);
  res.json(rows);
});

router.post("/batches/run", requireAccount, async (req, res) => {
  const isAdmin = Boolean(req.isPlatformAdmin);
  if (isAdmin && req.body?.allAccounts) {
    const r = await runAllAccounts();
    res.json({ totalPushed: r.pushed, totalFailed: r.failed, batches: [] });
    return;
  }
  const accountId = req.currentAccount!.id;
  const r = await runDailyBatchesForAccount(accountId);
  res.json({ totalPushed: r.pushed, totalFailed: r.failed, batches: [] });
});

export default router;
