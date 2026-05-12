import cron from "node-cron";
import { logger } from "../lib/logger";
import { runAllAccounts } from "../services/batchRunner";

let started = false;

export function startCron(): void {
  if (started) return;
  if (process.env.DISABLE_CRON === "true") return;
  started = true;
  // 2:00 AM Central, every day
  cron.schedule(
    "0 2 * * *",
    async () => {
      try {
        const r = await runAllAccounts();
        logger.info(r, "Daily batch run complete");
      } catch (err) {
        logger.error({ err }, "Daily batch run failed");
      }
    },
    { timezone: "America/Chicago" },
  );
  logger.info("Daily batch cron scheduled (02:00 America/Chicago)");
}
