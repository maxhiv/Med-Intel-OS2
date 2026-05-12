import { Router, type IRouter } from "express";
import { userContext } from "../middlewares/auth";
import healthRouter from "./health";
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

const router: IRouter = Router();

router.use(healthRouter);

// All routes below need user context.
router.use(userContext);

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
router.use(adminRouter);

export default router;
