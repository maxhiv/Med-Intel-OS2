import express, { type Express, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, users, accounts } from "@workspace/db";
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

export function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(healthRouter);
  app.use(testUserContext);
  app.use(meRouter);
  app.use(dashboardRouter);
  app.use(facilitiesRouter);
  app.use(signalsRouter);
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
