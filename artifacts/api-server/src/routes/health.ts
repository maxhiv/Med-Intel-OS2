import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { sql, gte, and, lt } from "drizzle-orm";
import { db, facilities, accountFacilities, conFilings, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";
import { getIngestorTelemetry, getAllIngestorTelemetry } from "../lib/ingestorTelemetry";

const router: IRouter = Router();

const startedAt = Date.now();

router.get("/healthz", async (_req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  let dbStatus: "ok" | "down" = "ok";
  let facilitiesCount = 0;
  let leadsCount = 0;
  let tierACount = 0;
  let tierBCount = 0;
  let tierCCount = 0;

  try {
    await db.execute(sql`select 1`);

    const [facRow] = await db.select({ c: sql<number>`count(*)::int` }).from(facilities);
    facilitiesCount = facRow?.c ?? 0;

    const [leadsRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilities)
      .where(gte(facilities.signalScore, 40));
    leadsCount = leadsRow?.c ?? 0;

    const [aRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilities)
      .where(gte(facilities.signalScore, 70));
    tierACount = aRow?.c ?? 0;

    const [bRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilities)
      .where(and(gte(facilities.signalScore, 50), lt(facilities.signalScore, 70)));
    tierBCount = bRow?.c ?? 0;

    const [cRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilities)
      .where(and(gte(facilities.signalScore, 40), lt(facilities.signalScore, 50)));
    tierCCount = cRow?.c ?? 0;
  } catch (err) {
    logger.error({ err }, "healthz: db query failed");
    dbStatus = "down";
  }

  const ingestorTelemetry = getAllIngestorTelemetry();
  const ingestorRegistry = Object.entries(ingestorTelemetry).map(([key, t]) => ({
    key,
    lastRun: t.lastRun,
    lastDurationMs: t.lastDurationMs,
    lastStatus: t.lastStatus,
  }));

  const base = HealthCheckResponse.parse({ status: dbStatus === "ok" ? "ok" : "degraded" });
  res.json({
    ...base,
    db: dbStatus,
    uptime: uptimeSeconds,
    facilitiesCount,
    leadsCount,
    tierACounts: { A: tierACount, B: tierBCount, C: tierCCount },
    ingestorRegistry,
  });
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

  let signalsCount = 0;
  let highScoreFacilities = 0;

  if (dbStatus === "ok") {
    try {
      const [sigRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(purchaseSignals);
      signalsCount = sigRow?.c ?? 0;

      const [hsRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(facilities)
        .where(gte(facilities.signalScore, 70));
      highScoreFacilities = hsRow?.c ?? 0;
    } catch {
      // non-critical
    }
  }

  const disableCron = process.env.DISABLE_CRON === "true";
  const conTelemetry = getIngestorTelemetry("conFilings");

  res.json({
    status: dbStatus === "ok" ? "ok" : "degraded",
    uptime: uptimeSeconds,
    db: dbStatus,
    facilitiesCount,
    accountFacilitiesLinked,
    conFilingsCount,
    signalsCount,
    highScoreFacilities,
    cronStatus: {
      nextRun: disableCron ? null : "~04:30 UTC daily",
    },
    ingestors: {
      lastRun: conTelemetry.lastRun,
      lastDurationMs: conTelemetry.lastDurationMs,
      lastStatus: conTelemetry.lastStatus,
      status: disableCron ? "disabled" : conTelemetry.lastRun ? "ran" : "scheduled",
    },
  });
});

export default router;
