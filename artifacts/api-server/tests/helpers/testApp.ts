import express, { type Express, type RequestHandler, Router } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  users,
  accounts,
  campaigns,
  outreachDrafts,
  accountFacilities,
  campaignContacts,
  sequences,
  contactEnrollments,
  syncBatches,
  replyEvents,
  reportTemplates,
  reportRuns,
  reportSchedules,
} from "@workspace/db";
import { rlsTransactionMiddleware } from "../../src/middlewares/rlsTransaction";
import { requireAccount } from "../../src/middlewares/auth";
import healthRouter from "../../src/routes/health";
import meRouter from "../../src/routes/me";
import dashboardRouter from "../../src/routes/dashboard";
import facilitiesRouter from "../../src/routes/facilities";
import contactsRouter from "../../src/routes/contacts";
import campaignsRouter from "../../src/routes/campaigns";
import sequencesRouter from "../../src/routes/sequences";
import draftsRouter from "../../src/routes/drafts";
import batchesRouter from "../../src/routes/batches";
import reportsRouter from "../../src/routes/reports";
import adminRouter from "../../src/routes/admin";
import signalsRouter from "../../src/routes/signals";
import leadsRouter from "../../src/routes/leads";
import { errorHandler } from "../../src/middlewares/errors";

/**
 * Test-only auth middleware. Replaces Clerk-backed userContext with a header
 * that names the user to load. Production app is unaffected because we
 * compose the test app from scratch instead of importing src/app.ts.
 */
const testUserContext: RequestHandler = async (req, _res, next) => {
  try {
    const userId = req.header("x-test-user-id");
    if (!userId) return next();

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return next();

    req.currentUser = user;
    req.isPlatformAdmin = user.role === "platform_admin";

    if (user.accountId) {
      const [acct] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, user.accountId))
        .limit(1);
      if (acct) req.currentAccount = acct;
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Test-only router that runs DELIBERATELY-UNFILTERED queries against
 * RLS-protected tables. The regression test asserts that even without
 * an application-level `WHERE account_id = ?`, a request can only read
 * its own tenant's rows — proof that the database layer enforces
 * isolation, not just the route code.
 */
const rlsProbeRouter = Router();

// Each entry is `[url-segment, drizzle table]`. The handler runs a SELECT *
// with NO `WHERE account_id` filter — the database (via RLS) is the only
// thing keeping tenants apart. The list must stay in sync with seed.ts's
// RLS_TABLES; if a future migration adds another tenant table, add it
// here too so the regression suite covers it.
const RLS_PROBE_TABLES = [
  ["account-facilities", accountFacilities],
  ["campaigns", campaigns],
  ["campaign-contacts", campaignContacts],
  ["sequences", sequences],
  ["contact-enrollments", contactEnrollments],
  ["drafts", outreachDrafts],
  ["sync-batches", syncBatches],
  ["reply-events", replyEvents],
  ["report-templates", reportTemplates],
  ["report-runs", reportRuns],
  ["report-schedules", reportSchedules],
] as const;

for (const [segment, table] of RLS_PROBE_TABLES) {
  rlsProbeRouter.get(
    `/__rls-probe/${segment}`,
    requireAccount,
    async (_req, res) => {
      const rows = await db.select().from(table);
      res.json(rows);
    },
  );
}

export function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(testUserContext);
  app.use(rlsTransactionMiddleware);
  app.use(rlsProbeRouter);
  app.use(meRouter);
  app.use(dashboardRouter);
  app.use(facilitiesRouter);
  app.use(signalsRouter);
  app.use(leadsRouter);
  app.use(contactsRouter);
  app.use(campaignsRouter);
  app.use(sequencesRouter);
  app.use(draftsRouter);
  app.use(batchesRouter);
  app.use(reportsRouter);
  app.use(adminRouter);
  app.use(errorHandler);
  return app;
}
