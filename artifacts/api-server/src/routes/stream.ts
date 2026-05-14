import { Router, type IRouter } from "express";
import { desc, eq, gt, inArray, and, isNull } from "drizzle-orm";
import {
  db,
  purchaseSignals,
  facilities,
  accountFacilities,
  conAlertNotifications,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";

const router: IRouter = Router();

const HEARTBEAT_MS = 15_000;
const POLL_MS = 30_000;

async function getTenantFacilityIds(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ id: accountFacilities.facilityId })
    .from(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  return rows.map((r) => r.id);
}

/**
 * SSE endpoint — streams new purchase signals and CON alert notifications to
 * the connected client.  Polls the DB every 30 s and pushes incremental
 * results so the frontend never needs a full page reload to see fresh data.
 *
 * Intentionally mounted BEFORE rlsTransactionMiddleware because SSE
 * connections are long-lived; wrapping them in a single Postgres transaction
 * would hold an idle connection open for the entire session lifetime.
 */
router.get("/stream/signals", requireAccount, (req, res) => {
  const accountId = req.currentAccount!.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable Nginx/proxy response buffering so events flush immediately.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("connected", { ts: new Date().toISOString() });

  // Track the high-water marks so each poll only returns genuinely new rows.
  let signalCursor = new Date();
  let alertCursor = new Date();

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);

  const poll = setInterval(async () => {
    try {
      const facIds = await getTenantFacilityIds(accountId);
      const nextSignalCursor = new Date();
      const nextAlertCursor = new Date();

      if (facIds.length > 0) {
        const newSignals = await db
          .select({
            id: purchaseSignals.id,
            facilityId: purchaseSignals.facilityId,
            facilityName: facilities.name,
            facilityState: facilities.state,
            signalType: purchaseSignals.signalType,
            signalValue: purchaseSignals.signalValue,
            confidence: purchaseSignals.confidence,
            source: purchaseSignals.source,
            detectedAt: purchaseSignals.detectedAt,
            isActive: purchaseSignals.isActive,
          })
          .from(purchaseSignals)
          .innerJoin(facilities, eq(facilities.id, purchaseSignals.facilityId))
          .where(
            and(
              eq(purchaseSignals.isActive, true),
              inArray(purchaseSignals.facilityId, facIds),
              gt(purchaseSignals.detectedAt, signalCursor),
            ),
          )
          .orderBy(desc(purchaseSignals.detectedAt))
          .limit(20);

        if (newSignals.length > 0) {
          send("signals", newSignals);
        }
      }
      signalCursor = nextSignalCursor;

      // New unread CON alert notifications for this account.
      const newAlerts = await db
        .select({
          id: conAlertNotifications.id,
          state: conAlertNotifications.state,
          modality: conAlertNotifications.modality,
          statusNormalized: conAlertNotifications.statusNormalized,
          applicantName: conAlertNotifications.applicantName,
          createdAt: conAlertNotifications.createdAt,
        })
        .from(conAlertNotifications)
        .where(
          and(
            eq(conAlertNotifications.accountId, accountId),
            isNull(conAlertNotifications.readAt),
            gt(conAlertNotifications.createdAt, alertCursor),
          ),
        )
        .orderBy(desc(conAlertNotifications.createdAt))
        .limit(10);

      if (newAlerts.length > 0) {
        send("con-alerts", { count: newAlerts.length, items: newAlerts });
      }
      alertCursor = nextAlertCursor;
    } catch {
      // Swallow poll errors — connection may be in the process of closing.
    }
  }, POLL_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(poll);
  };

  req.on("close", cleanup);
});

export default router;
