/**
 * MedIntel OS — bulk-seed orchestrator.
 *
 * Runs every bulk-seed step in dependency order. Each step is independent
 * and records its own row in `source_seed_runs`, so partial failures are
 * resumable: re-running this orchestrator skips steps whose latest run
 * status is 'ok' for the same file sha256.
 *
 * Order matters because signals key on facility_id:
 *   1.  nppes              — establishes the facility universe (CCN + NPI)
 *   2.  irs_bmf            — IRS Business Master File (EIN ↔ org name)
 *   3.  irs_990            — full IRS 990 dataset; backfills financials
 *   4.  cms_provider       — beds, ownership, ratings, readmissions
 *   5.  hcris              — cost report financials + depreciation spikes
 *   6.  fda_bulk           — 510k + classification (reference data, no signals)
 *                            + recall + maude (emits adverse_event signals)
 *   7.  clinical_trials    — full corpus, emits clinical_trial signals
 *   8.  nih_grants         — multi-year ExPORTER export, emits grant_awarded
 *   9.  usa_spending       — healthcare NAICS contract awards, emits aip_infra_spend
 *  10.  sec_edgar          — full-text quarterly index (filings list only)
 *  11.  medicare_util      — practitioner utilization, emits high_utilization
 *                            (optional — needs operator --url)
 *
 * Usage:
 *   pnpm --filter @workspace/api-server seed:all                  # run all
 *   pnpm --filter @workspace/api-server seed:all --only hcris     # one source
 *   pnpm --filter @workspace/api-server seed:all --skip sec_edgar # all but one
 *   pnpm --filter @workspace/api-server seed:all --force          # ignore sha256 cache
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../../lib/logger";
import { parseFlags } from "./_lib";
import { runHcrisSeed } from "./hcris";
import { runFdaBulkSeed } from "./fda-bulk";
import { runClinicalTrialsSeed } from "./clinical-trials";
import { runNihGrantsSeed } from "./nih-grants";
import { runUsaSpendingSeed } from "./usa-spending";
import { runCmsProviderSeed } from "./cms-provider-data";
import { runSecEdgarSeed } from "./sec-edgar";
import { runMedicareUtilizationSeed } from "./medicare-utilization";
import { runImport990 } from "../../services/import990Runner";

interface SeedStep {
  name: string;
  description: string;
  needs?: string[];
  runner: (force: boolean) => Promise<unknown>;
}

// ─── External-process wrappers ────────────────────────────────────────────

function runShell(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit", cwd });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    proc.on("error", reject);
  });
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../");

// ─── Steps ────────────────────────────────────────────────────────────────

const STEPS: SeedStep[] = [
  {
    name: "nppes",
    description: "NPPES NPI registry bulk import (Python streaming script)",
    runner: async () => {
      const zipPath = process.env.NPPES_ZIP_PATH ?? path.join(REPO_ROOT, ".seed-data/nppes/npi.zip");
      logger.info({ zipPath }, "nppes: invoking scripts/seed-npi.py");
      // The Python script reads DATABASE_URL from the environment.
      await runShell("python3", ["scripts/seed-npi.py", "--zip", zipPath], REPO_ROOT);
    },
  },
  {
    name: "irs_bmf",
    description: "IRS Business Master File (EIN ↔ org name)",
    runner: async () => {
      await runShell(
        "pnpm",
        ["--filter", "@workspace/api-server", "exec", "tsx", "src/scripts/importEoBmf.ts"],
        REPO_ROOT,
      );
    },
  },
  {
    name: "irs_990",
    description: "Full IRS 990 dataset — 7-phase pipeline",
    needs: ["irs_bmf"],
    runner: async () => {
      const result = await runImport990();
      logger.info(result, "irs_990: phases complete");
    },
  },
  {
    name: "cms_provider",
    description: "CMS Provider Data — hospital general info, MSPB, readmissions, …",
    needs: ["nppes"],
    runner: async (force) => {
      const r = await runCmsProviderSeed({ force });
      logger.info(r, "cms_provider: done");
    },
  },
  {
    name: "hcris",
    description: "CMS Hospital Provider Cost Report — beds, financials, depreciation spikes",
    needs: ["nppes"],
    runner: async (force) => {
      const r = await runHcrisSeed({ force });
      logger.info(r, "hcris: done");
    },
  },
  {
    name: "fda_bulk",
    description: "openFDA bulk — 510k, classification, recall, MAUDE",
    runner: async (force) => {
      const r = await runFdaBulkSeed({
        endpoints: ["510k", "classification", "recall", "maude"],
        force,
      });
      logger.info(r, "fda_bulk: done");
    },
  },
  {
    name: "clinical_trials",
    description: "ClinicalTrials.gov full corpus via v2 API pagination",
    needs: ["nppes"],
    runner: async (force) => {
      const r = await runClinicalTrialsSeed({ force });
      logger.info(r, "clinical_trials: done");
    },
  },
  {
    name: "nih_grants",
    description: "NIH RePORTER annual ExPORTER CSV — last 5 fiscal years",
    needs: ["nppes"],
    runner: async (force) => {
      const r = await runNihGrantsSeed({ force });
      logger.info(r, "nih_grants: done");
    },
  },
  {
    name: "usa_spending",
    description: "USA Spending bulk download — healthcare NAICS contract awards",
    needs: ["nppes"],
    runner: async (force) => {
      const r = await runUsaSpendingSeed({ force });
      logger.info(r, "usa_spending: done");
    },
  },
  {
    name: "sec_edgar",
    description: "SEC EDGAR quarterly full-text index files (last 8 quarters)",
    runner: async (force) => {
      const r = await runSecEdgarSeed({ force });
      logger.info(r, "sec_edgar: done");
    },
  },
  {
    name: "medicare_util",
    description: "Medicare physician utilization — needs MEDICARE_UTIL_URL env var",
    needs: ["nppes"],
    runner: async (force) => {
      const url = process.env.MEDICARE_UTIL_URL;
      if (!url) {
        logger.warn("medicare_util: MEDICARE_UTIL_URL not set, skipping");
        return;
      }
      const r = await runMedicareUtilizationSeed({ url, force });
      logger.info(r, "medicare_util: done");
    },
  },
];

// ─── Entry ────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const only = typeof flags.only === "string" ? flags.only.split(",").map((s) => s.trim()) : null;
  const skip = typeof flags.skip === "string" ? flags.skip.split(",").map((s) => s.trim()) : [];
  const force = flags.force === true;
  const dryRun = flags["dry-run"] === true;

  const plan = STEPS.filter((s) => {
    if (only && !only.includes(s.name)) return false;
    if (skip.includes(s.name)) return false;
    return true;
  });

  logger.info(
    { steps: plan.map((s) => s.name), force, dryRun },
    "seed:all — execution plan",
  );

  if (dryRun) {
    for (const s of plan) {
      logger.info({ name: s.name, needs: s.needs ?? [], description: s.description }, "seed:all step");
    }
    return;
  }

  for (const step of plan) {
    const start = Date.now();
    logger.info({ step: step.name, description: step.description }, "▶ seed:all step starting");
    try {
      await step.runner(force);
      logger.info(
        { step: step.name, durationMs: Date.now() - start },
        "✓ seed:all step complete",
      );
    } catch (err) {
      logger.error({ step: step.name, err }, "✗ seed:all step FAILED");
      // Don't abort the whole plan — record the failure (each runner already
      // wrote a row to source_seed_runs with status='failed') and continue.
      // Operator can re-run with `--only <failed-step>` after fixing.
    }
  }

  logger.info("seed:all — done. Inspect source_seed_runs for per-step status.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "seed:all crashed");
      process.exit(1);
    });
}
