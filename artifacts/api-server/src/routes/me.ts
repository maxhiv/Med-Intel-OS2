import { Router, type IRouter } from "express";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import {
  db,
  accounts,
  subAccounts,
  conAlertSubscriptions,
  conAlertNotifications,
} from "@workspace/db";
import { requireAuth, requireAccount } from "../middlewares/auth";
import { logger } from "../lib/logger";

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

// Dedicated sub-accounts listing for the current account.
// Used by UI components (e.g. Pipeline modal) that need a fresh fetch rather
// than relying on the cached /me payload.
router.get("/me/sub-accounts", requireAuth, requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const subs = await db
    .select({
      id: subAccounts.id,
      name: subAccounts.name,
      crmType: subAccounts.crmType,
    })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, accountId), eq(subAccounts.isActive, true)));
  res.json({ data: subs });
});

// ---------------------------------------------------------------------------
// Account settings (stored in accounts.settings JSONB)
// ---------------------------------------------------------------------------

router.get("/me/settings", requireAuth, requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const [row] = await db
    .select({ settings: accounts.settings })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  res.json((row?.settings as Record<string, unknown>) ?? {});
});

router.patch("/me/settings", requireAuth, requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Allow-list of settings keys the user may write
  const ALLOWED_KEYS = new Set(["slackWebhookUrl"]);
  const incoming: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_KEYS.has(k)) incoming[k] = v;
  }

  // Read current settings and merge
  const [row] = await db
    .select({ settings: accounts.settings })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  const current = (row?.settings as Record<string, unknown>) ?? {};
  const merged = { ...current, ...incoming };

  const [updated] = await db
    .update(accounts)
    .set({ settings: merged, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning({ settings: accounts.settings });

  res.json((updated?.settings as Record<string, unknown>) ?? {});
});

// Test the account's configured Slack webhook URL by posting a sample message.
router.post(
  "/me/settings/test-slack",
  requireAuth,
  requireAccount,
  async (req, res) => {
    const accountId = req.currentAccount!.id;
    const [row] = await db
      .select({ settings: accounts.settings })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    const settings = (row?.settings as Record<string, unknown>) ?? {};
    const webhookUrl = typeof settings.slackWebhookUrl === "string"
      ? settings.slackWebhookUrl.trim()
      : "";

    if (!webhookUrl) {
      res.status(400).json({ ok: false, error: "no_webhook_url_configured" });
      return;
    }

    if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
      res.status(400).json({ ok: false, error: "invalid_webhook_url" });
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "✅ MedIntel OS — Slack webhook test successful! CON filing alerts will be delivered here.",
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        res.status(502).json({ ok: false, error: "slack_rejected", details: body });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      logger.warn({ err, accountId }, "me: slack webhook test failed");
      res.status(502).json({ ok: false, error: "network_error", message: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// CON-filing alert subscription + in-app notifications
// ---------------------------------------------------------------------------

const VALID_STATUS_FILTERS = new Set(["any", "approved", "denied", "under_review", "pending", "filed"]);

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
