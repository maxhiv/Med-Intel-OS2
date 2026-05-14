import { Router, type IRouter } from "express";
import { sql, desc, eq, and, type SQL } from "drizzle-orm";
import { db, conFilings, facilities, accountFacilities } from "@workspace/db";
import { requirePlatformAdmin, requireAccount } from "../middlewares/auth";
import { recomputeAllScores } from "../services/signalScorer";
import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor";
import { ingestConFilings } from "../services/conFilingsIngestor";
import { ingestNppes } from "../services/nppesIngestor";
import { ingestFda510k } from "../services/fda510kIngestor";
import { ingestFdaRecalls } from "../services/fdaRecallsIngestor";
import { ingestFdaMaude } from "../services/fdaMaudeIngestor";
import { ingestFdaClassification } from "../services/fdaClassificationIngestor";
import { ingestPropublica990 } from "../services/propublica990Ingestor";
import { ingestCmsData } from "../services/cmsDataIngestor";
import { ingestSecEdgar } from "../services/secEdgarIngestor";
import { ingestUsaSpending } from "../services/usaSpendingIngestor";
import { ingestSamGov } from "../services/samGovIngestor";
import { ingestEmma } from "../services/emmaIngestor";
import { ingestHcris } from "../services/hcrisIngestor";
import { ingestHrsa } from "../services/hrsaIngestor";
import { ingestUsda } from "../services/usdaIngestor";
import { ingestMedicareUtil } from "../services/medicareUtilIngestor";

const router: IRouter = Router();

// List recent CON filings, optionally filtered by state and approved-vs-filed
// status. Returned to any account user — CON data is public, not tenant-scoped.
// Mirrors `looksApproved()` in conFilingsIngestor.ts at the SQL level. Some
// adapters store normalized values ("approved"/"filed") while others persist
// raw source text (e.g. "Approved with conditions", "Application received"),
// so filtering and badge logic must match against the keyword pattern instead
// of an exact string.
const NORMALIZED_STATUS_SQL = sql<"approved" | "filed" | null>`
  CASE
    WHEN ${conFilings.status} IS NULL THEN NULL
    WHEN ${conFilings.status} ~* 'approv|grant(ed)?|issued' THEN 'approved'
    ELSE 'filed'
  END
`;

router.get("/signals/con-filings", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const stateRaw = typeof req.query.state === "string" ? req.query.state.trim().toUpperCase() : "";
  const statusRaw = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";

  const filters: SQL[] = [];
  if (stateRaw.length === 2) {
    filters.push(eq(conFilings.state, stateRaw));
  }
  if (statusRaw === "approved") {
    filters.push(sql`${conFilings.status} ~* 'approv|grant(ed)?|issued'`);
  } else if (statusRaw === "filed") {
    filters.push(
      sql`${conFilings.status} IS NOT NULL AND ${conFilings.status} !~* 'approv|grant(ed)?|issued'`,
    );
  }
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // CON filings come from public state regulators and aren't tenant-owned, so
  // every account user sees the full feed. To avoid dead facility links we
  // mark each row's matched facility as accessible only when it's in the
  // current account's facility set.
  const ownedRows = await db
    .select({ id: accountFacilities.facilityId })
    .from(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  const ownedSet = new Set(ownedRows.map((r) => r.id));

  const rows = await db
    .select({
      id: conFilings.id,
      facilityId: conFilings.facilityId,
      facilityName: facilities.name,
      state: conFilings.state,
      filingDate: conFilings.filingDate,
      decisionDate: conFilings.decisionDate,
      equipmentType: conFilings.equipmentType,
      modality: conFilings.modality,
      requestedAmount: conFilings.requestedAmount,
      approvedAmount: conFilings.approvedAmount,
      status: conFilings.status,
      statusNormalized: NORMALIZED_STATUS_SQL,
      applicantName: conFilings.applicantName,
      filingUrl: conFilings.filingUrl,
      notes: conFilings.notes,
      matchScore: conFilings.matchScore,
      matchField: conFilings.matchField,
      reviewStatus: conFilings.reviewStatus,
      createdAt: conFilings.createdAt,
    })
    .from(conFilings)
    .leftJoin(facilities, eq(facilities.id, conFilings.facilityId))
    .where(whereClause)
    .orderBy(
      desc(sql`COALESCE(${conFilings.filingDate}, ${conFilings.createdAt}::date)`),
    )
    .limit(limit)
    .offset(offset);

  const data = rows.map((r) => ({
    ...r,
    matchScore: r.matchScore == null ? null : Number(r.matchScore),
    facilityAccessible: r.facilityId ? ownedSet.has(r.facilityId) : false,
  }));

  const [{ c: total }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(conFilings)
    .where(whereClause);

  const stateRows = await db
    .selectDistinct({ state: conFilings.state })
    .from(conFilings)
    .orderBy(conFilings.state);
  const states = stateRows.map((r) => r.state).filter((s): s is string => !!s);

  res.json({ data, total, limit, offset, states });
});

router.post("/signals/recompute", requirePlatformAdmin, async (_req, res) => {
  const result = await recomputeAllScores();
  res.json(result);
});

// Manually trigger the ClinicalTrials.gov ingestor. Useful for ops + tests so
// new signals can be backfilled without waiting for the 04:30 cron tick.
router.post(
  "/signals/ingest/clinicaltrials",
  requirePlatformAdmin,
  async (req, res) => {
    const raw = req.query.limit;
    let limit: number | undefined;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ error: "limit_must_be_positive_number" });
        return;
      }
      limit = Math.floor(n);
    }
    const result = await ingestClinicalTrials({ limit });
    res.json(result);
  },
);

// Manually trigger the state CON-filings ingestor. Useful for ops + tests.
router.post(
  "/signals/ingest/con-filings",
  requirePlatformAdmin,
  async (_req, res) => {
    const result = await ingestConFilings();
    res.json(result);
  },
);

// Manually trigger any combination of the no-key free-API ingestors.
// Use ?source={name} to run a single source; omit for all.
// Valid sources: nppes, fda_510k, fda_recalls, fda_maude, fda_class,
//   propublica_990, cms_data, sec_edgar, usa_spending,
//   sam_gov, emma_bonds, hcris, hrsa, usda, medicare_util
router.post(
  "/signals/ingest/free-apis",
  requirePlatformAdmin,
  async (req, res) => {
    const sourceParam =
      typeof req.query.source === "string" ? req.query.source.trim() : "";

    const ingestors: Record<
      string,
      () => Promise<{ signalsInserted: number; errors: number }>
    > = {
      nppes:          () => ingestNppes({ limit: 50 }),
      fda_510k:       () => ingestFda510k({ limit: 50 }),
      fda_recalls:    () => ingestFdaRecalls({ limit: 50 }),
      fda_maude:      () => ingestFdaMaude({ limit: 50 }),
      fda_class:      () => ingestFdaClassification({ limit: 50 }),
      propublica_990: () => ingestPropublica990({ limit: 40 }),
      cms_data:       () => ingestCmsData({ limit: 50 }),
      sec_edgar:      () => ingestSecEdgar({ limit: 40 }),
      usa_spending:   () => ingestUsaSpending({ limit: 40 }),
      sam_gov:        () => ingestSamGov({ limit: 50 }),
      emma_bonds:     () => ingestEmma({ limit: 30 }),
      hcris:          () => ingestHcris({ limit: 50 }),
      hrsa:           () => ingestHrsa({ limit: 50 }),
      usda:           () => ingestUsda({ limit: 50 }),
      medicare_util:  () => ingestMedicareUtil({ limit: 50 }),
    };

    if (sourceParam && !ingestors[sourceParam]) {
      res.status(400).json({
        error: "unknown_source",
        valid: Object.keys(ingestors),
      });
      return;
    }

    const toRun = sourceParam
      ? { [sourceParam]: ingestors[sourceParam] }
      : ingestors;

    const results: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(toRun)) {
      try {
        results[name] = await fn();
      } catch (err) {
        results[name] = { error: String(err) };
      }
    }
    res.json(results);
  },
);

export default router;
