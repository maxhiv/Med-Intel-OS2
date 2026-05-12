import { Router, type IRouter } from "express";
import { requirePlatformAdmin } from "../middlewares/auth";
import { recomputeAllScores } from "../services/signalScorer";

const router: IRouter = Router();

router.post("/signals/recompute", requirePlatformAdmin, async (_req, res) => {
  const result = await recomputeAllScores();
  res.json(result);
});

export default router;
