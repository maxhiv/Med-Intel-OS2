import { Router, type IRouter } from "express";
import { userContext } from "../middlewares/auth";
import { rlsTransactionMiddleware } from "../middlewares/rlsTransaction";
import healthRouter from "./health";
import webhooksRouter from "./webhooks";
import meRouter from "./me";
import dashboardRouter from "./dashboard";
import facilitiesRouter from "./facilities";
import signalsRouter from "./signals";
import contactsRouter from "./contacts";
import campaignsRouter from "./campaigns";
import sequencesRouter from "./sequences";
import draftsRouter from "./drafts";
import batchesRouter from "./batches";
import reportsRouter from "./reports";
import adminRouter from "./admin";
import oauthRouter from "./oauth";
import streamRouter from "./stream";
import leadsRouter from "./leads";
import territoriesRouter from "./territories";
import equipmentLinesRouter from "./equipmentLines";

const router: IRouter = Router();

router.use(healthRouter);

// Inbound CRM webhooks are unauthenticated (vendor-signed). Mount before
// userContext so we don't run a Clerk lookup on every webhook hit.
router.use(webhooksRouter);

// All routes below need user context.
router.use(userContext);

// SSE stream must be mounted before rlsTransactionMiddleware because SSE
// connections are long-lived; wrapping them in a single Postgres transaction
// would hold an idle connection open for the entire session lifetime.
router.use(streamRouter);

// Engage Postgres RLS for the rest of the request lifecycle so tenant
// isolation is enforced at the database layer even if a route forgets its
// `WHERE account_id = ?` filter. Skipped for platform admins and for routes
// without a loaded account (see middleware).
router.use(rlsTransactionMiddleware);

router.use(meRouter);
router.use(dashboardRouter);
router.use(facilitiesRouter);
router.use(signalsRouter);
router.use(contactsRouter);
router.use(campaignsRouter);
router.use(sequencesRouter);
router.use(draftsRouter);
router.use(batchesRouter);
router.use(reportsRouter);
router.use(leadsRouter);
router.use(territoriesRouter);
router.use(equipmentLinesRouter);
router.use(adminRouter);
router.use(oauthRouter);

export default router;
