/**
 * National ingest orchestrator — one round, all states, all sources.
 *
 * Shared by the admin API (on-demand trigger) and the bulk-ingest script.
 * Tracks job state in a module-level singleton so the admin status endpoint
 * can poll progress without a database table.
 *
 * Call `startNationalIngest()` to fire a background job (fire-and-forget).
 * Read `nationalIngestJob` at any time for current state.
 */
import { randomUUID } from "node:crypto";
import { ingestFdaClassification }  from "./fdaClassificationIngestor";
import { ingestNppes }              from "./nppesIngestor";
import { ingestCmsData }            from "./cmsDataIngestor";
import { ingestUsaSpending }        from "./usaSpendingIngestor";
import { ingestClinicalTrials }     from "./clinicalTrialsIngestor";
import { ingestSecEdgar }           from "./secEdgarIngestor";
import { ingestPropublica990 }      from "./propublica990Ingestor";
import { ingestHrsa }               from "./hrsaIngestor";
import { ingestUsda }               from "./usdaIngestor";
import { ingestHcris }              from "./hcrisIngestor";
import { ingestFda510k }            from "./fda510kIngestor";
import { ingestFdaMaude }           from "./fdaMaudeIngestor";
import { ingestSamGov }             from "./samGovIngestor";
import { ingestEmma }               from "./emmaIngestor";
import { ingestFdaRecalls }         from "./fdaRecallsIngestor";
import { ingestMedicareUtil }       from "./medicareUtilIngestor";
import { ingestConFilings }         from "./conFilingsIngestor";
import { recomputeAllScores }       from "./signalScorer";
import { logger }                   from "../lib/logger";

export const TOP_20_STATES = [
  "CA", "TX", "FL", "IL", "NY", "MD", "PA", "OH", "AZ", "NC",
  "NJ", "MI", "CO", "GA", "VA", "WA", "TN", "MN", "MO", "IN",
];

export const ALL_50_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

export interface NationalIngestJob {
  jobId: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: "idle" | "running" | "done" | "error";
  states: string[];
  limit: number;
  signalsInserted: number;
  facilitiesScanned: number;
  errors: number;
  currentSource: string | null;
  completedSources: string[];
  recomputeScores: boolean;
  errorMessage?: string;
}

const IDLE_JOB: NationalIngestJob = {
  jobId: "",
  startedAt: new Date(0),
  finishedAt: null,
  status: "idle",
  states: [],
  limit: 0,
  signalsInserted: 0,
  facilitiesScanned: 0,
  errors: 0,
  currentSource: null,
  completedSources: [],
  recomputeScores: false,
};

export let nationalIngestJob: NationalIngestJob = { ...IDLE_JOB };

interface SourceResult {
  signalsInserted: number;
  errors: number;
  facilitiesScanned?: number;
}

async function runSource(
  job: NationalIngestJob,
  name: string,
  fn: () => Promise<SourceResult>,
): Promise<void> {
  job.currentSource = name;
  try {
    const r = await fn();
    job.signalsInserted += r.signalsInserted;
    job.errors += r.errors;
    job.facilitiesScanned += r.facilitiesScanned ?? 0;
    logger.info({ source: name, signals: r.signalsInserted, errors: r.errors }, "national ingest source done");
  } catch (err) {
    logger.warn({ err, source: name }, "national ingest source threw");
    job.errors += 1;
  }
  job.completedSources.push(name);
  job.currentSource = null;
}

async function runAllSources(job: NationalIngestJob): Promise<void> {
  const { states, limit } = job;
  const opts = { limit, states };
  const optsNoStates = { limit };

  // Batch A — parallel, no rate sensitivity
  await Promise.all([
    runSource(job, "fda_classification", () => ingestFdaClassification(opts)),
    runSource(job, "nppes",              () => ingestNppes(opts)),
    runSource(job, "fda_510k",           () => ingestFda510k(optsNoStates)),
  ]);

  // Batch B — parallel, moderate rate
  await Promise.all([
    runSource(job, "cms_data",       () => ingestCmsData(opts)),
    runSource(job, "usa_spending",   () => ingestUsaSpending(opts)),
    runSource(job, "clinical_trials", () => ingestClinicalTrials(opts)),
    runSource(job, "sec_edgar",      () => ingestSecEdgar(opts)),
    runSource(job, "hcris",          () => ingestHcris(optsNoStates)),
  ]);

  // Batch C — sequential (rate-sensitive external APIs)
  await runSource(job, "propublica_990",  () => ingestPropublica990(opts));
  await runSource(job, "hrsa",            () => ingestHrsa(opts));
  await runSource(job, "usda",            () => ingestUsda(opts));
  await runSource(job, "emma",            () => ingestEmma(optsNoStates));
  await runSource(job, "fda_maude",       () => ingestFdaMaude(optsNoStates));
  await runSource(job, "fda_recalls",     () => ingestFdaRecalls(optsNoStates));
  await runSource(job, "medicare_util",   () => ingestMedicareUtil(optsNoStates));
  await runSource(job, "sam_gov",         () => ingestSamGov(optsNoStates));
  await runSource(job, "con_filings",     () => ingestConFilings());
}

/**
 * Starts a national ingest round in the background.
 * Returns immediately. Poll `nationalIngestJob` for progress.
 * If a job is already running, returns false.
 */
export function startNationalIngest(opts: {
  states?: string[];
  limit?: number;
  recomputeScores?: boolean;
} = {}): { started: boolean; job: NationalIngestJob } {
  if (nationalIngestJob.status === "running") {
    return { started: false, job: nationalIngestJob };
  }

  const job: NationalIngestJob = {
    jobId: randomUUID(),
    startedAt: new Date(),
    finishedAt: null,
    status: "running",
    states: opts.states ?? TOP_20_STATES,
    limit: opts.limit ?? 500,
    signalsInserted: 0,
    facilitiesScanned: 0,
    errors: 0,
    currentSource: null,
    completedSources: [],
    recomputeScores: opts.recomputeScores ?? true,
  };
  nationalIngestJob = job;

  // Fire and forget
  runAllSources(job)
    .then(async () => {
      if (job.recomputeScores) {
        job.currentSource = "recompute_scores";
        try {
          await recomputeAllScores();
        } catch (err) {
          logger.warn({ err }, "recomputeAllScores failed in national ingest");
        }
        job.currentSource = null;
        job.completedSources.push("recompute_scores");
      }
      job.status = "done";
      job.finishedAt = new Date();
      logger.info(
        { signals: job.signalsInserted, errors: job.errors, durationMs: job.finishedAt.getTime() - job.startedAt.getTime() },
        "national ingest complete",
      );
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.finishedAt = new Date();
      job.errorMessage = String(err);
      logger.error({ err }, "national ingest failed");
    });

  return { started: true, job };
}
