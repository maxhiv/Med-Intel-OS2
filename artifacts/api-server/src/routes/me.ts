import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, subAccounts } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res) => {
  const accountId = req.currentAccount?.id;
  const subs = accountId
    ? await db
        .select()
        .from(subAccounts)
        .where(
          and(
            eq(subAccounts.accountId, accountId),
            eq(subAccounts.isActive, true),
          ),
        )
    : [];
  res.json({
    user: req.currentUser,
    account: req.currentAccount ?? undefined,
    isPlatformAdmin: Boolean(req.isPlatformAdmin),
    subAccounts: subs,
  });
});

export default router;
