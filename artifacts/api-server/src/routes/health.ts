import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { sql } from "drizzle-orm";
import { db, facilities, accountFacilities, conFilings } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const startedAt = Date.now();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ status: "ok", db: "ok" });
  } catch (err) {
    logger.error({ err }, "readyz: db ping failed");
    res.status(503).json({ status: "degraded", db: "down" });
  }
});

router.get("/health", async (_req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  let dbStatus: "ok" | "down" = "ok";
  let facilitiesCount = 0;
  let accountFacilitiesLinked = 0;
  let conFilingsCount = 0;

  try {
    await db.execute(sql`select 1`);

    const [facRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilities);
    facilitiesCount = facRow?.c ?? 0;

    const [afRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(accountFacilities);
    accountFacilitiesLinked = afRow?.c ?? 0;

    const [cfRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(conFilings);
    conFilingsCount = cfRow?.c ?? 0;
  } catch (err) {
    logger.error({ err }, "health: db query failed");
    dbStatus = "down";
  }

  const disableCron = process.env.DISABLE_CRON === "true";

  res.json({
    status: dbStatus === "ok" ? "ok" : "degraded",
    uptimeSeconds,
    db: dbStatus,
    cronEnabled: !disableCron,
    ingestors: {
      clinicalTrials: "scheduled",
      conFilings: "scheduled",
      nppes: "scheduled",
      fda510k: "scheduled",
      fdaRecalls: "scheduled",
      fdaMaude: "scheduled",
      fdaClassification: "scheduled",
      propublica990: "scheduled",
      cmsData: "scheduled",
      secEdgar: "scheduled",
      usaSpending: "scheduled",
      samGov: process.env.SAM_GOV_API_KEY ? "scheduled" : "disabled_no_key",
      emmaBonds: "scheduled",
      hcris: "scheduled",
      hrsa: "scheduled",
      usda: "scheduled",
      medicareUtil: "scheduled",
    },
    stats: {
      facilitiesCount,
      accountFacilitiesLinked,
      conFilingsCount,
    },
  });
});

export default router;
