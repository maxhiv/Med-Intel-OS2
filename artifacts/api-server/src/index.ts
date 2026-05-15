import app from "./app";
import { logger } from "./lib/logger";
import { startCron } from "./cron";

// Fail fast with actionable messages rather than silent 401/500s at runtime.
const REQUIRED_ENV = ["DATABASE_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CRM_ENCRYPTION_KEY"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Required environment variable ${key} is not set. Check the Replit Secrets panel.`);
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startCron();
});
