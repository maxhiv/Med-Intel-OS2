import { Router, type IRouter } from "express";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import {
  db,
  subAccounts,
  conAlertSubscriptions,
  conAlertNotifications,
} from "@workspace/db";
import { requireAuth, requireAccount } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res) => {
  const accountId = req.currentAccount?.id;
  const subs = accountId
    ? await db
        .select()
        .from(subAccounts)
        .where(
          and(
            eq(subAccounts.accountId, accountId),
            eq(subAccounts.isActive, true),
          ),
        )
    : [];
  res.json({
    user: req.currentUser,
    account: req.currentAccount ?? undefined,
    isPlatformAdmin: Boolean(req.isPlatformAdmin),
    subAccounts: subs,
  });
});

// ---------------------------------------------------------------------------
// CON-filing alert subscription + in-app notifications
// ---------------------------------------------------------------------------

const VALID_STATUS_FILTERS = new Set(["any", "approved", "filed"]);

function sanitizeStates(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(s)) out.add(s);
  }
  return Array.from(out).sort();
}

function sanitizeModalities(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim().toUpperCase().slice(0, 20);
    if (s) out.add(s);
  }
  return Array.from(out).sort();
}

router.get(
  "/me/con-alert-subscription",
  requireAuth,
  requireAccount,
  async (req, res) => {
    const userId = req.currentUser!.id;
    const [row] = await db
      .select()
      .from(conAlertSubscriptions)
      .where(eq(conAlertSubscriptions.userId, userId))
      .limit(1);
    res.json(row ?? null);
  },
);

router.put(
  "/me/con-alert-subscription",
  requireAuth,
  requireAccount,
  async (req, res) => {
    const userId = req.currentUser!.id;
    const accountId = req.currentAccount!.id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const states = sanitizeStates(body.states);
    const modalities = sanitizeModalities(body.modalities);
    const statusFilterRaw =
      typeof body.statusFilter === "string" ? body.statusFilter : "any";
    const statusFilter = VALID_STATUS_FILTERS.has(statusFilterRaw)
      ? statusFilterRaw
      : "any";
    const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

    const [existing] = await db
      .select({ id: conAlertSubscriptions.id })
      .from(conAlertSubscriptions)
      .where(eq(conAlertSubscriptions.userId, userId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(conAlertSubscriptions)
        .set({
          states,
          modalities,
          statusFilter,
          isActive,
          updatedAt: new Date(),
        })
        .where(eq(conAlertSubscriptions.id, existing.id))
        .returning();
      res.json(updated);
      return;
    }

    const [created] = await db
      .insert(conAlertSubscriptions)
      .values({
        accountId,
        userId,
        states,
        modalities,
        statusFilter,
        isActive,
      })
      .returning();
    res.status(201).json(created);
  },
);

router.get(
  "/me/con-alert-notifications",
  requireAuth,
  requireAccount,
  async (req, res) => {
    const userId = req.currentUser!.id;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const unreadOnly = req.query.unread === "true";

    const conditions = [eq(conAlertNotifications.userId, userId)];
    if (unreadOnly) conditions.push(isNull(conAlertNotifications.readAt));

    const rows = await db
      .select()
      .from(conAlertNotifications)
      .where(and(...conditions))
      .orderBy(desc(conAlertNotifications.createdAt))
      .limit(limit);

    const [{ unread }] = await db
      .select({ unread: sql<number>`count(*)::int` })
      .from(conAlertNotifications)
      .where(
        and(
          eq(conAlertNotifications.userId, userId),
          isNull(conAlertNotifications.readAt),
        ),
      );

    res.json({ data: rows, unread });
  },
);

router.post(
  "/me/con-alert-notifications/read-all",
  requireAuth,
  requireAccount,
  async (req, res) => {
    const userId = req.currentUser!.id;
    const result = await db
      .update(conAlertNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(conAlertNotifications.userId, userId),
          isNull(conAlertNotifications.readAt),
        ),
      )
      .returning({ id: conAlertNotifications.id });
    res.json({ marked: result.length });
  },
);

router.post(
  "/me/con-alert-notifications/:id/read",
  requireAuth,
  requireAccount,
  async (req, res) => {
    const userId = req.currentUser!.id;
    const id = String(req.params.id);
    const [updated] = await db
      .update(conAlertNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(conAlertNotifications.id, id),
          eq(conAlertNotifications.userId, userId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(updated);
  },
);

export default router;
