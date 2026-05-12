import { Router, type IRouter } from "express";
import { eq, or, isNull, desc } from "drizzle-orm";
import { db, reportTemplates, reportRuns } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/reports/templates", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const rows = await db
    .select()
    .from(reportTemplates)
    .where(
      or(eq(reportTemplates.accountId, accountId), isNull(reportTemplates.accountId)),
    )
    .orderBy(desc(reportTemplates.createdAt));
  res.json(rows);
});

router.post("/reports/templates", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const {
    name,
    description,
    category,
    dataSources,
    fieldConfig,
    filterConfig,
    vizType,
  } = req.body ?? {};
  if (!name || !Array.isArray(dataSources)) {
    res.status(400).json({ error: "name_and_dataSources_required" });
    return;
  }
  const [created] = await db
    .insert(reportTemplates)
    .values({
      accountId,
      name,
      description: description ?? null,
      category: category ?? null,
      dataSources,
      fieldConfig: fieldConfig ?? [],
      filterConfig: filterConfig ?? [],
      vizType: vizType ?? "table",
      isSystemTemplate: false,
      createdBy: req.currentUser?.id ?? null,
    })
    .returning();
  res.status(201).json(created);
});

router.post("/reports/run", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const { templateId, runtimeFilters } = req.body ?? {};
  if (!templateId) {
    res.status(400).json({ error: "templateId_required" });
    return;
  }
  const [tpl] = await db
    .select()
    .from(reportTemplates)
    .where(eq(reportTemplates.id, templateId))
    .limit(1);
  if (!tpl) {
    res.status(404).json({ error: "template_not_found" });
    return;
  }
  // Ownership: must be system template or belong to this account
  if (!tpl.isSystemTemplate && tpl.accountId !== accountId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const startedAt = new Date();
  const [created] = await db
    .insert(reportRuns)
    .values({
      templateId,
      accountId,
      triggeredBy: "manual",
      triggeredByUser: req.currentUser?.id ?? null,
      runtimeFilters: runtimeFilters ?? {},
      status: "complete",
      rowCount: 0,
      durationMs: 0,
      startedAt,
      completedAt: new Date(),
    })
    .returning();
  res.json(created);
});

router.get("/reports/runs", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await db
    .select()
    .from(reportRuns)
    .where(eq(reportRuns.accountId, accountId))
    .orderBy(desc(reportRuns.queuedAt))
    .limit(limit);
  res.json(rows);
});

export default router;
