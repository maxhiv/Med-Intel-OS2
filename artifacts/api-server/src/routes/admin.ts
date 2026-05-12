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
  facilityContacts,
  syncBatches,
  contactValidationLog,
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

router.patch(
  "/admin/enrichment-sources/:source/budget",
  requirePlatformAdmin,
  async (req, res) => {
    const source = parseSource(String(req.params.source));
    if (!source) {
      res.status(400).json({ error: "invalid_source" });
      return;
    }
    if ((FREE_ENRICHMENT_SOURCES as readonly string[]).includes(source)) {
      res.status(400).json({ error: "free_source_has_no_budget" });
      return;
    }
    const raw = req.body?.monthBudgetCents;
    let budgetMicros: number | null;
    if (raw === null || raw === undefined) {
      budgetMicros = null;
    } else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      budgetMicros = Math.round(raw) * 10_000;
    } else {
      res.status(400).json({ error: "invalid_monthBudgetCents" });
      return;
    }
    await db
      .insert(enrichmentSourceApprovals)
      .values({
        source,
        approved: false,
        monthlyBudgetLimit: budgetMicros,
      })
      .onConflictDoUpdate({
        target: enrichmentSourceApprovals.source,
        set: {
          monthlyBudgetLimit: budgetMicros,
          updatedAt: new Date(),
        },
      });
    const found = (await listAllSources()).find((s) => s.source === source);
    res.json(found);
  },
);

router.get("/admin/platform-stats", requirePlatformAdmin, async (_req, res) => {
  // Note: users field intentionally not in PlatformStats schema
  void users;
  const [acctCount] = await db
    .select({
      c: sql<number>`count(*) FILTER (WHERE ${accounts.status} = 'active')::int`,
    })
    .from(accounts);
  const [facCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(facilities);
  const [contactCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(facilityContacts);
  const [verifiedContactCount] = await db
    .select({
      c: sql<number>`count(*) FILTER (WHERE ${facilityContacts.emailStatus} = 'verified' OR ${facilityContacts.humanVerified} = true)::int`,
    })
    .from(facilityContacts);
  const [sigCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(purchaseSignals)
    .where(eq(purchaseSignals.isActive, true));
  const [pendingDraftCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(eq(outreachDrafts.status, "pending"));
  const [batchesTodayCount] = await db
    .select({
      c: sql<number>`count(*) FILTER (WHERE ${syncBatches.batchDate} = CURRENT_DATE)::int`,
    })
    .from(syncBatches);

  res.json({
    activeAccounts: acctCount.c,
    totalFacilities: facCount.c,
    totalContacts: contactCount.c,
    verifiedContacts: verifiedContactCount.c,
    pendingDrafts: pendingDraftCount.c,
    activeSignals: sigCount.c,
    batchesToday: batchesTodayCount.c,
  });
});

// Per-validator outcome counts over the last 30 days. Useful for ops to
// compare ZeroBounce vs Bouncer accuracy and spot validators that are
// silently erroring out.
router.get("/admin/validation-stats", requirePlatformAdmin, async (_req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      source: contactValidationLog.checkType,
      result: contactValidationLog.result,
      count: sql<number>`count(*)::int`,
    })
    .from(contactValidationLog)
    .where(
      sql`${contactValidationLog.checkedAt} >= ${thirtyDaysAgo} AND ${contactValidationLog.checkType} IN ('zerobounce', 'bouncer')`,
    )
    .groupBy(contactValidationLog.checkType, contactValidationLog.result);

  // Make sure both validators always show up so the UI can render zero-state
  // rows instead of just hiding inactive providers.
  const bySource = new Map<
    string,
    { source: string; verified: number; bounced: number; error: number; other: number; total: number }
  >();
  for (const v of ["zerobounce", "bouncer"]) {
    bySource.set(v, { source: v, verified: 0, bounced: 0, error: 0, other: 0, total: 0 });
  }
  for (const r of rows) {
    const entry = bySource.get(r.source) ?? {
      source: r.source,
      verified: 0,
      bounced: 0,
      error: 0,
      other: 0,
      total: 0,
    };
    if (r.result === "verified") entry.verified += r.count;
    else if (r.result === "bounced") entry.bounced += r.count;
    else if (r.result === "error") entry.error += r.count;
    else entry.other += r.count;
    entry.total += r.count;
    bySource.set(r.source, entry);
  }

  res.json(Array.from(bySource.values()));
});

export default router;
