/**
 * Schedule registry. Each job runs guarded by a simple in-process lock so a
 * long-running run can't double-fire. Cron jobs are skipped entirely when
 * DISABLE_CRON=true (useful for tests and CI).
 */
import cron from "node-cron";
import { logger } from "../lib/logger";
import { runAllAccounts } from "../services/batchRunner";
import { recomputeAllScores } from "../services/signalScorer";

let started = false;
const locks = new Set<string>();

function guarded(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (locks.has(name)) {
      logger.warn({ job: name }, "cron job still running; skipping tick");
      return;
    }
    locks.add(name);
    const start = Date.now();
    try {
      await fn();
      logger.info({ job: name, ms: Date.now() - start }, "cron job complete");
    } catch (err) {
      logger.error({ err, job: name }, "cron job failed");
    } finally {
      locks.delete(name);
    }
  };
}

export function startCron(): void {
  if (started) return;
  if (process.env.DISABLE_CRON === "true") {
    logger.info("DISABLE_CRON=true; skipping cron registration");
    return;
  }
  started = true;
  const tz = "America/Chicago";

  // 02:00 daily — push approved drafts to each tenant's CRM.
  cron.schedule(
    "0 2 * * *",
    guarded("dailyBatch", async () => {
      const r = await runAllAccounts();
      logger.info(r, "daily batch run complete");
    }),
    { timezone: tz },
  );

  // 03:00 daily — recompute composite signal scores so dashboards stay fresh.
  cron.schedule(
    "0 3 * * *",
    guarded("recomputeSignals", async () => {
      const r = await recomputeAllScores();
      logger.info(r, "signal recompute complete");
    }),
    { timezone: tz },
  );

  // Every 15 minutes — heartbeat / placeholder for the enrichment queue worker.
  // Real ingestors hook in here (NPI nightly, Doximity refresh, etc.).
  cron.schedule(
    "*/15 * * * *",
    guarded("enrichmentTick", async () => {
      logger.debug("enrichment queue tick (no-op stub)");
    }),
  );

  logger.info("Cron jobs scheduled: dailyBatch, recomputeSignals, enrichmentTick");
}
