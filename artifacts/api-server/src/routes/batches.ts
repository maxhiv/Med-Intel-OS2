import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, syncBatches } from "@workspace/db";
import { requireAccount, requirePlatformAdmin } from "../middlewares/auth";
import { runDailyBatchesForAccount, runAllAccounts } from "../services/batchRunner";

const router: IRouter = Router();

router.get("/batches", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const rows = await db
    .select()
    .from(syncBatches)
    .where(eq(syncBatches.accountId, accountId))
    .orderBy(desc(syncBatches.batchDate))
    .limit(limit);
  res.json(rows);
});

router.post("/batches/run", requireAccount, async (req, res) => {
  const isAdmin = Boolean(req.isPlatformAdmin);
  if (isAdmin && req.body?.allAccounts) {
    const r = await runAllAccounts();
    res.json({ totalPushed: r.pushed, totalFailed: 0, batches: [] });
    return;
  }
  const accountId = req.currentAccount!.id;
  const r = await runDailyBatchesForAccount(accountId);
  res.json({ totalPushed: r.pushed, totalFailed: 0, batches: [] });
});

export default router;
// requirePlatformAdmin re-exported for type-checker; not used directly here.
void requirePlatformAdmin;
