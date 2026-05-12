import { Router, type IRouter } from "express";
import { eq, sql, desc } from "drizzle-orm";
import {
  db,
  accounts,
  users,
  subAccounts,
  enrichmentSourceApprovals,
  facilities,
  purchaseSignals,
  outreachDrafts,
  FREE_ENRICHMENT_SOURCES,
  PAID_ENRICHMENT_SOURCES,
} from "@workspace/db";
import { requirePlatformAdmin } from "../middlewares/auth";
import { listAllSources } from "../services/enrichment";

const ALL_ENRICHMENT_SOURCES = [
  ...FREE_ENRICHMENT_SOURCES,
  ...PAID_ENRICHMENT_SOURCES,
] as const;
type EnrichmentSourceKey = (typeof ALL_ENRICHMENT_SOURCES)[number];

function parseSource(raw: string): EnrichmentSourceKey | null {
  return (ALL_ENRICHMENT_SOURCES as readonly string[]).includes(raw)
    ? (raw as EnrichmentSourceKey)
    : null;
}

const router: IRouter = Router();

router.get("/admin/accounts", requirePlatformAdmin, async (_req, res) => {
  const rows = await db.select().from(accounts).orderBy(desc(accounts.createdAt));
  res.json(rows);
});

router.post("/admin/accounts", requirePlatformAdmin, async (req, res) => {
  const { name, slug, planTier, defaultCrm, batchLimitDaily, status } =
    req.body ?? {};
  if (!name || !slug) {
    res.status(400).json({ error: "name_and_slug_required" });
    return;
  }
  const [created] = await db
    .insert(accounts)
    .values({
      name,
      slug,
      planTier: planTier ?? "starter",
      defaultCrm: defaultCrm ?? "ghl",
      batchLimitDaily: batchLimitDaily ?? 10,
      status: status ?? "trial",
    })
    .returning();
  res.status(201).json(created);
});

router.patch("/admin/accounts/:id", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const allowed: Record<string, unknown> = {};
  for (const k of [
    "name",
    "slug",
    "planTier",
    "defaultCrm",
    "batchLimitDaily",
    "status",
  ]) {
    if (k in (req.body ?? {})) allowed[k] = req.body[k];
  }
  allowed.updatedAt = new Date();
  const [updated] = await db
    .update(accounts)
    .set(allowed)
    .where(eq(accounts.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

router.get("/admin/sub-accounts", requirePlatformAdmin, async (req, res) => {
  const accountId = req.query.accountId as string | undefined;
  const rows = await db
    .select()
    .from(subAccounts)
    .where(accountId ? eq(subAccounts.accountId, accountId) : undefined)
    .orderBy(desc(subAccounts.createdAt));
  res.json(rows);
});

router.post("/admin/sub-accounts", requirePlatformAdmin, async (req, res) => {
  const { accountId, name, crmType, batchSizeDaily, repName, repEmail, timezone } =
    req.body ?? {};
  if (!accountId || !name) {
    res.status(400).json({ error: "accountId_and_name_required" });
    return;
  }
  const [created] = await db
    .insert(subAccounts)
    .values({
      accountId,
      name,
      crmType: crmType ?? "ghl",
      batchSizeDaily: batchSizeDaily ?? 10,
      repName: repName ?? null,
      repEmail: repEmail ?? null,
      timezone: timezone ?? "America/Chicago",
    })
    .returning();
  res.status(201).json(created);
});

router.get("/admin/users", requirePlatformAdmin, async (_req, res) => {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  res.json(rows);
});

router.get(
  "/admin/enrichment-sources",
  requirePlatformAdmin,
  async (_req, res) => {
    const rows = await listAllSources();
    res.json(rows);
  },
);

router.post(
  "/admin/enrichment-sources/:source/approve",
  requirePlatformAdmin,
  async (req, res) => {
    const source = parseSource(String(req.params.source));
    if (!source) {
      res.status(400).json({ error: "invalid_source" });
      return;
    }
    const notes = (req.body?.notes as string | undefined) ?? null;
    await db
      .insert(enrichmentSourceApprovals)
      .values({
        source,
        approved: true,
        approvedAt: new Date(),
        approvedBy: req.currentUser?.id ?? null,
        notes,
      })
      .onConflictDoUpdate({
        target: enrichmentSourceApprovals.source,
        set: {
          approved: true,
          approvedAt: new Date(),
          approvedBy: req.currentUser?.id ?? null,
          notes,
          updatedAt: new Date(),
        },
      });
    const found = (await listAllSources()).find((s) => s.source === source);
    res.json(found);
  },
);

router.post(
  "/admin/enrichment-sources/:source/revoke",
  requirePlatformAdmin,
  async (req, res) => {
    const source = parseSource(String(req.params.source));
    if (!source) {
      res.status(400).json({ error: "invalid_source" });
      return;
    }
    await db
      .update(enrichmentSourceApprovals)
      .set({
        approved: false,
        approvedAt: null,
        approvedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(enrichmentSourceApprovals.source, source));
    const found = (await listAllSources()).find((s) => s.source === source);
    res.json(found);
  },
);

router.get("/admin/platform-stats", requirePlatformAdmin, async (_req, res) => {
  const [acctCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(accounts);
  const [userCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(users);
  const [facCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(facilities);
  const [sigCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(purchaseSignals)
    .where(eq(purchaseSignals.isActive, true));
  const [draftCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts);

  res.json({
    accounts: acctCount.c,
    users: userCount.c,
    facilities: facCount.c,
    activeSignals: sigCount.c,
    drafts: draftCount.c,
  });
});

export default router;
