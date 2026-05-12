import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/me", requireAuth, (req, res) => {
  res.json({
    user: req.currentUser,
    account: req.currentAccount ?? undefined,
    isPlatformAdmin: Boolean(req.isPlatformAdmin),
  });
});

export default router;
