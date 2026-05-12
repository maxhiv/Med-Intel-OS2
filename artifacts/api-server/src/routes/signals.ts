import { Router, type IRouter } from "express";
import { requirePlatformAdmin } from "../middlewares/auth";
import { recomputeAllScores } from "../services/signalScorer";
import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor";

const router: IRouter = Router();

router.post("/signals/recompute", requirePlatformAdmin, async (_req, res) => {
  const result = await recomputeAllScores();
  res.json(result);
});

// Manually trigger the ClinicalTrials.gov ingestor. Useful for ops + tests so
// new signals can be backfilled without waiting for the 04:30 cron tick.
router.post(
  "/signals/ingest/clinicaltrials",
  requirePlatformAdmin,
  async (req, res) => {
    const raw = req.query.limit;
    let limit: number | undefined;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ error: "limit_must_be_positive_number" });
        return;
      }
      limit = Math.floor(n);
    }
    const result = await ingestClinicalTrials({ limit });
    res.json(result);
  },
);

export default router;
