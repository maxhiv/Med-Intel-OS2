/**
 * Admin routes for the v2.0 paid-source dual-gate system.
 *
 * Mounted under /api — paths resolve to /api/admin/paid-sources/*.
 * All routes require an account context; approve/revoke require
 * tenant_admin, the limits PUT requires operator.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, agentUsageLimits, paidSourceCallLog } from "@workspace/db";
import { z } from "zod/v4";
import { requireAccount } from "../middlewares/auth";
import { requireTenantAdmin, requireOperator } from "../middlewares/requireRole";
import { paidSourceGate } from "../services/agent/paidSourceGate";

const router: IRouter = Router();

// ─── GET /admin/paid-sources — the dual-gate matrix ─────────────────────────
router.get("/admin/paid-sources", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const approvals = await paidSourceGate.listApprovals(accountId);
  res.json({ approvals });
});

// ─── GET /admin/paid-sources/usage — today's per-source call stats ──────────
// Registered before the /:source param routes so "usage" isn't captured.
router.get("/admin/paid-sources/usage", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const rows = await db
    .select({
      sourceName: paidSourceCallLog.sourceName,
      successfulCalls: sql<number>`COUNT(*) FILTER (WHERE ${paidSourceCallLog.responseStatus} = 'success')::int`,
      deniedCalls: sql<number>`COUNT(*) FILTER (WHERE ${paidSourceCallLog.responseStatus} LIKE 'denied_%')::int`,
      totalCostUsd: sql<string>`COALESCE(SUM(${paidSourceCallLog.costUsd}), 0)::text`,
      avgLatencyMs: sql<number>`COALESCE(AVG(${paidSourceCallLog.latencyMs}), 0)::int`,
    })
    .from(paidSourceCallLog)
    .where(
      and(
        eq(paidSourceCallLog.accountId, accountId),
        sql`${paidSourceCallLog.createdAt} >= CURRENT_DATE`,
      ),
    )
    .groupBy(paidSourceCallLog.sourceName);
  res.json({ day: new Date().toISOString().slice(0, 10), sources: rows });
});

// ─── GET /admin/paid-sources/limits — current per-account limits ────────────
router.get("/admin/paid-sources/limits", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const [row] = await db
    .select()
    .from(agentUsageLimits)
    .where(eq(agentUsageLimits.accountId, accountId))
    .limit(1);
  res.json({ limits: row ?? null });
});

// ─── PUT /admin/paid-sources/limits — operator-only limit update ────────────
const limitsBody = z.object({
  maxQueriesPerUserPerDay: z.number().int().positive().max(100_000).optional(),
  maxQueriesPerAccountPerDay: z.number().int().positive().max(1_000_000).optional(),
  maxAnthropicCostPerDayUsd: z.number().nonnegative().max(100_000).optional(),
  maxAnthropicCostPerMonthUsd: z.number().nonnegative().max(1_000_000).optional(),
  hardStopAtLimit: z.boolean().optional(),
});

router.put("/admin/paid-sources/limits", requireAccount, requireOperator(), async (req, res) => {
  const accountId = req.currentAccount!.id;
  const parsed = limitsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.issues });
    return;
  }
  const v = parsed.data;
  const [row] = await db
    .insert(agentUsageLimits)
    .values({
      accountId,
      ...(v.maxQueriesPerUserPerDay != null
        ? { maxQueriesPerUserPerDay: v.maxQueriesPerUserPerDay }
        : {}),
      ...(v.maxQueriesPerAccountPerDay != null
        ? { maxQueriesPerAccountPerDay: v.maxQueriesPerAccountPerDay }
        : {}),
      ...(v.maxAnthropicCostPerDayUsd != null
        ? { maxAnthropicCostPerDayUsd: String(v.maxAnthropicCostPerDayUsd) }
        : {}),
      ...(v.maxAnthropicCostPerMonthUsd != null
        ? { maxAnthropicCostPerMonthUsd: String(v.maxAnthropicCostPerMonthUsd) }
        : {}),
      ...(v.hardStopAtLimit != null ? { hardStopAtLimit: v.hardStopAtLimit } : {}),
      updatedByUserId: req.currentUser!.id,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: agentUsageLimits.accountId,
      set: {
        ...(v.maxQueriesPerUserPerDay != null
          ? { maxQueriesPerUserPerDay: v.maxQueriesPerUserPerDay }
          : {}),
        ...(v.maxQueriesPerAccountPerDay != null
          ? { maxQueriesPerAccountPerDay: v.maxQueriesPerAccountPerDay }
          : {}),
        ...(v.maxAnthropicCostPerDayUsd != null
          ? { maxAnthropicCostPerDayUsd: String(v.maxAnthropicCostPerDayUsd) }
          : {}),
        ...(v.maxAnthropicCostPerMonthUsd != null
          ? { maxAnthropicCostPerMonthUsd: String(v.maxAnthropicCostPerMonthUsd) }
          : {}),
        ...(v.hardStopAtLimit != null ? { hardStopAtLimit: v.hardStopAtLimit } : {}),
        updatedByUserId: req.currentUser!.id,
        updatedAt: new Date(),
      },
    })
    .returning();
  res.json({ limits: row });
});

// ─── POST /admin/paid-sources/:source/approve ───────────────────────────────
const approvalBody = z.object({ notes: z.string().max(2000).optional() });

router.post(
  "/admin/paid-sources/:source/approve",
  requireAccount,
  requireTenantAdmin(),
  async (req, res) => {
    const accountId = req.currentAccount!.id;
    const notes = approvalBody.safeParse(req.body).data?.notes;
    const { updated } = await paidSourceGate.setApproval({
      accountId,
      sourceName: String(req.params.source),
      approved: true,
      userId: req.currentUser!.id,
      notes,
    });
    if (!updated) {
      res.status(404).json({ error: "unknown_source", source: req.params.source });
      return;
    }
    res.json({ ok: true, source: req.params.source, approved: true });
  },
);

// ─── POST /admin/paid-sources/:source/revoke ────────────────────────────────
router.post(
  "/admin/paid-sources/:source/revoke",
  requireAccount,
  requireTenantAdmin(),
  async (req, res) => {
    const accountId = req.currentAccount!.id;
    const notes = approvalBody.safeParse(req.body).data?.notes ?? "revoked via admin UI";
    const { updated } = await paidSourceGate.setApproval({
      accountId,
      sourceName: String(req.params.source),
      approved: false,
      userId: req.currentUser!.id,
      notes,
    });
    if (!updated) {
      res.status(404).json({ error: "unknown_source", source: req.params.source });
      return;
    }
    res.json({ ok: true, source: req.params.source, approved: false });
  },
);

export default router;
