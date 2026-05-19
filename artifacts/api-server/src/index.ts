import app from "./app";
import { logger } from "./lib/logger";
import { startCron } from "./cron";
import { seedSystemEquipmentLineProfiles } from "./services/equipmentLineService";

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

  // Idempotent seed of system equipment-line rubrics so per-line scoring
  // works out of the box for every deployment.
  seedSystemEquipmentLineProfiles()
    .then((r) => logger.info(r, "equipment-line profiles seeded"))
    .catch((err) => logger.error({ err }, "equipment-line seed failed"));
});
