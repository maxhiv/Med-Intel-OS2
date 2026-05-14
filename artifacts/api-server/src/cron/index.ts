/**
 * Schedule registry. Each job runs guarded by a simple in-process lock so a
 * long-running run can't double-fire. Cron jobs are skipped entirely when
 * DISABLE_CRON=true (useful for tests and CI).
 *
 * Tenant safety: jobs that touch RLS-protected tables (sync_batches,
 * outreach_drafts, contact_enrollments, …) MUST run their per-account work
 * inside `withRLS(accountId, …)` so a forgotten `WHERE account_id` filter
 * cannot leak across tenants. The per-account services here
 * (`runDailyBatchesForAccount`, `retryFailedItemsInBatch`,
 * `generateDraftsForCampaign`) wrap themselves; the cross-account
 * `runAllAccounts` fans out one RLS-scoped transaction per account rather
 * than running globally.
 *
 * The remaining jobs registered below (`recomputeAllScores`,
 * `ingestClinicalTrials`, `ingestConFilings`, `rolloverSpendCounters`,
 * `enrichmentTick`) only read/write shared, non-RLS tables (facilities,
 * purchase_signals, equipment_records, con_filings,
 * enrichment_source_approvals, contact_validation_log) so there is no
 * tenant-scope to engage — wrapping them in withRLS would be a no-op.
 */
import cron from "node-cron";
import { logger } from "../lib/logger";
import { runAllAccounts } from "../services/batchRunner";
import { recomputeAllScores } from "../services/signalScorer";
import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor";
import { ingestConFilings } from "../services/conFilingsIngestor";
import { notifyConAlerts } from "../services/conAlertNotifier";
import { rolloverSpendCounters } from "../services/monthRollover";
import { classifyPendingReplies } from "../services/replyClassifier";
import { ingestNppes } from "../services/nppesIngestor";
import { ingestFda510k } from "../services/fda510kIngestor";
import { ingestFdaRecalls } from "../services/fdaRecallsIngestor";
import { ingestFdaMaude } from "../services/fdaMaudeIngestor";
import { ingestFdaClassification } from "../services/fdaClassificationIngestor";
import { ingestPropublica990 } from "../services/propublica990Ingestor";
import { ingestCmsData } from "../services/cmsDataIngestor";
import { ingestSecEdgar } from "../services/secEdgarIngestor";
import { ingestUsaSpending } from "../services/usaSpendingIngestor";
import { ingestSamGov } from "../services/samGovIngestor";
import { ingestEmma } from "../services/emmaIngestor";
import { ingestHcris } from "../services/hcrisIngestor";
import { ingestHrsa } from "../services/hrsaIngestor";
import { ingestUsda } from "../services/usdaIngestor";
import { ingestMedicareUtil } from "../services/medicareUtilIngestor";

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
      // Fan out alerts as soon as the ingestor finishes so high-intent
      // filings reach reps' inboxes the same morning. Runs serially behind
      // the ingest under the same lock window so we never tick again until
      // both the fetch and the notifier have completed.
      const n = await notifyConAlerts();
      logger.info(n, "con alert notifier complete");
    }),
    { timezone: tz },
  );

  // Every 10 minutes — best-effort follow-up notifier tick. Catches filings
  // inserted manually (admin "Run ingestor now"), or by the daily ingestor
  // when a new subscription is created mid-day. Idempotent — already-sent
  // alerts are filtered by the unique (subscription, filing) index.
  cron.schedule(
    "*/10 * * * *",
    guarded("notifyConAlerts", async () => {
      const r = await notifyConAlerts();
      if (r.notificationsCreated > 0 || r.errors > 0) {
        logger.info(r, "con alert notifier tick");
      }
    }),
  );

  // 00:05 UTC daily — proactively roll over the per-source month-to-date
  // spend counters. Lazy resets in the enrichment service cover normal
  // traffic, but this guarantees the rollover happens even if no enrichment
  // calls land on the 1st (e.g. quiet weekend) so the admin dashboard never
  // shows last month's number stuck on screen.
  cron.schedule(
    "5 0 * * *",
    guarded("rolloverSpendCounters", async () => {
      const r = await rolloverSpendCounters();
      logger.info(r, "spend counter rollover complete");
    }),
    { timezone: "UTC" },
  );

  // 06:00 daily — ingest free public APIs: NPPES NPI Registry, FDA 510(k),
  // FDA Recalls, FDA MAUDE, FDA Device Classification, ProPublica 990,
  // CMS Provider Data, SEC EDGAR, and USASpending.gov. All sources are
  // no-key, rate-limit-polite (per-source delays), and idempotent by signal
  // value so reruns produce no duplicate rows.
  cron.schedule(
    "0 6 * * *",
    guarded("ingestFreeApis", async () => {
      const sources: { name: string; fn: () => Promise<{ signalsInserted: number; errors: number }> }[] = [
        { name: "nppes",          fn: () => ingestNppes({ limit: 50 }) },
        { name: "fda_510k",       fn: () => ingestFda510k({ limit: 50 }) },
        { name: "fda_recalls",    fn: () => ingestFdaRecalls({ limit: 50 }) },
        { name: "fda_maude",      fn: () => ingestFdaMaude({ limit: 50 }) },
        { name: "fda_class",      fn: () => ingestFdaClassification({ limit: 50 }) },
        { name: "propublica_990", fn: () => ingestPropublica990({ limit: 40 }) },
        { name: "cms_data",       fn: () => ingestCmsData({ limit: 50 }) },
        { name: "sec_edgar",      fn: () => ingestSecEdgar({ limit: 40 }) },
        { name: "usa_spending",   fn: () => ingestUsaSpending({ limit: 40 }) },
        { name: "sam_gov",        fn: () => ingestSamGov({ limit: 50 }) },
        { name: "emma_bonds",     fn: () => ingestEmma({ limit: 30 }) },
        { name: "hcris",          fn: () => ingestHcris({ limit: 50 }) },
        { name: "hrsa",           fn: () => ingestHrsa({ limit: 50 }) },
        { name: "usda",           fn: () => ingestUsda({ limit: 50 }) },
        { name: "medicare_util",  fn: () => ingestMedicareUtil({ limit: 50 }) },
      ];
      for (const s of sources) {
        try {
          const r = await s.fn();
          logger.info({ source: s.name, ...r }, "free api ingest source complete");
        } catch (err) {
          logger.error({ err, source: s.name }, "free api ingest source failed");
        }
      }
    }),
    { timezone: tz },
  );

  // Every 2 minutes — classify any new inbound CRM replies with Anthropic so
  // the Drafts page can surface qualified replies and so unsubscribe /
  // not-interested replies pause the contact's sequence enrollment quickly.
  cron.schedule(
    "*/2 * * * *",
    guarded("classifyReplies", async () => {
      const r = await classifyPendingReplies(25);
      if (r.examined > 0) logger.info(r, "reply classification batch complete");
    }),
  );

  logger.info(
    "Cron jobs scheduled: dailyBatch, recomputeSignals, enrichmentTick, ingestClinicalTrials, ingestConFilings, ingestFreeApis (15 sources), rolloverSpendCounters, classifyReplies",
  );
}
