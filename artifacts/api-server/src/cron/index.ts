/**
 * Schedule registry. Each job runs guarded by a simple in-process lock so a
 * long-running run can't double-fire. Cron jobs are skipped entirely when
 * DISABLE_CRON=true (useful for tests and CI).
 */
import cron from "node-cron";
import { logger } from "../lib/logger";
import { runAllAccounts } from "../services/batchRunner";
import { recomputeAllScores } from "../services/signalScorer";
import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor";
import { ingestConFilings } from "../services/conFilingsIngestor";

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

  // Every 15 minutes — enrichment-queue heartbeat. Real per-contact workers
  // hook in here (Doximity refresh, paid validators, etc.).
  cron.schedule(
    "*/15 * * * *",
    guarded("enrichmentTick", async () => {
      logger.debug("enrichment queue tick");
    }),
  );

  // 04:30 daily — pull recently-updated trials from ClinicalTrials.gov for
  // tracked facilities and emit `clinical_trial` purchase signals. Free
  // public source, no API key required, idempotent by NCT id.
  cron.schedule(
    "30 4 * * *",
    guarded("ingestClinicalTrials", async () => {
      const r = await ingestClinicalTrials({ limit: 100 });
      logger.info(r, "clinicaltrials ingest complete");
    }),
    { timezone: tz },
  );

  // 05:15 daily — pull recent CON filings from a few state portals and emit
  // `con_filed` / `con_approved` purchase signals. Each state adapter is
  // best-effort (returns [] on any HTTP/parse failure) so a single broken
  // portal never breaks the others.
  cron.schedule(
    "15 5 * * *",
    guarded("ingestConFilings", async () => {
      const r = await ingestConFilings();
      logger.info(r, "con filings ingest complete");
    }),
    { timezone: tz },
  );

  logger.info(
    "Cron jobs scheduled: dailyBatch, recomputeSignals, enrichmentTick, ingestClinicalTrials, ingestConFilings",
  );
}
