import crypto, { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { eq, sql, desc, and } from "drizzle-orm";
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
  replyEvents,
  crmKeyRotationEvents,
  FREE_ENRICHMENT_SOURCES,
  PAID_ENRICHMENT_SOURCES,
} from "@workspace/db";
import { requirePlatformAdmin } from "../middlewares/auth";
import { listAllSources } from "../services/enrichment";
import {
  blobNeedsRotation,
  currentKeyId,
  decodeStoredCredentials,
  decryptJsonWithFallback,
  encryptJson,
  isEncryptedBlob,
  maskSecret,
  previousKeyId,
  type EncryptedBlob,
} from "../services/encryption";
import {
  getCrmAdapter,
  listCrmAdapters,
  type CredentialFieldSpec,
} from "../services/crmAdapters";

const SUPPORTED_WEBHOOK_CRMS = ["ghl", "hubspot", "salesforce"] as const;
type WebhookCrm = (typeof SUPPORTED_WEBHOOK_CRMS)[number];

function publicBaseUrl(req: Request): string {
  const envBase = process.env.PUBLIC_API_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  const replitDomain = process.env.REPLIT_DEV_DOMAIN;
  if (replitDomain) return `https://${replitDomain}`;
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ??
    req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host") ?? "";
  return `${proto}://${host}`;
}

function buildWebhookUrl(req: Request, crm: WebhookCrm, subAccountId: string): string {
  return `${publicBaseUrl(req)}/api/webhooks/${crm}/${subAccountId}`;
}

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

/**
 * Inspect the credential editor schema + currently-stored values for a
 * sub-account. Secret fields are masked (last 4 chars only); non-secret
 * fields are returned in clear so the admin sees what's there.
 */
router.get(
  "/admin/sub-accounts/:id/credentials",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [sub] = await db.select().from(subAccounts).where(eq(subAccounts.id, id)).limit(1);
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const adapter = getCrmAdapter(sub.crmType);
    if (!adapter) {
      res.json({
        subAccountId: sub.id,
        crmType: sub.crmType ?? null,
        encrypted: false,
        schema: [],
        fields: {},
        adapterAvailable: false,
      });
      return;
    }
    const decoded = decodeStoredCredentials<Record<string, unknown>>(
      sub.crmCredentials ?? {},
    );
    const fields: Record<string, { present: boolean; value: string | null }> = {};
    for (const f of adapter.credentialSchema as CredentialFieldSpec[]) {
      const raw = decoded[f.key];
      const present = raw !== undefined && raw !== null && raw !== "";
      const value = present
        ? f.secret
          ? maskSecret(String(raw))
          : String(raw)
        : null;
      fields[f.key] = { present, value };
    }
    res.json({
      subAccountId: sub.id,
      crmType: sub.crmType,
      encrypted: isEncryptedBlob(sub.crmCredentials),
      adapterAvailable: true,
      schema: adapter.credentialSchema,
      fields,
    });
  },
);

/**
 * Replace the stored CRM credentials for a sub-account. Body: a flat
 * object matching the adapter's credential schema (e.g. `{ accessToken,
 * locationId }`). Optional `crmType` switches the sub-account's CRM type
 * at the same time. The blob is encrypted at rest and never returned to
 * the client in plaintext.
 */
router.put(
  "/admin/sub-accounts/:id/credentials",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [sub] = await db.select().from(subAccounts).where(eq(subAccounts.id, id)).limit(1);
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = (req.body ?? {}) as {
      crmType?: string;
      credentials?: Record<string, unknown>;
    };
    const nextCrmType = body.crmType ?? sub.crmType ?? undefined;
    const adapter = getCrmAdapter(nextCrmType);
    if (!adapter) {
      res
        .status(400)
        .json({ error: "unsupported_crm_type", crmType: nextCrmType ?? null });
      return;
    }
    const incoming = body.credentials ?? {};
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      res.status(400).json({ error: "credentials_must_be_object" });
      return;
    }

    // Merge with existing decrypted creds so the UI can submit only the
    // fields it changed (secrets the admin chose not to re-enter remain).
    const existing = decodeStoredCredentials<Record<string, unknown>>(
      sub.crmCredentials ?? {},
    );
    const merged: Record<string, unknown> = { ...existing };
    for (const f of adapter.credentialSchema as CredentialFieldSpec[]) {
      if (Object.prototype.hasOwnProperty.call(incoming, f.key)) {
        const v = incoming[f.key];
        if (v === null || v === "") delete merged[f.key];
        else merged[f.key] = v;
      }
    }

    // Validate required fields are present after merge.
    const missing: string[] = [];
    for (const f of adapter.credentialSchema as CredentialFieldSpec[]) {
      if (f.required && (merged[f.key] === undefined || merged[f.key] === "")) {
        missing.push(f.key);
      }
    }
    if (missing.length > 0) {
      res
        .status(400)
        .json({ error: "missing_required_credentials", fields: missing });
      return;
    }

    const encrypted = encryptJson(merged);
    const [updated] = await db
      .update(subAccounts)
      .set({
        crmType: adapter.type,
        crmCredentials: encrypted,
        updatedAt: new Date(),
      })
      .where(eq(subAccounts.id, id))
      .returning();

    // Return the redacted view so the UI can refresh state without exposing secrets.
    const fields: Record<string, { present: boolean; value: string | null }> = {};
    for (const f of adapter.credentialSchema as CredentialFieldSpec[]) {
      const raw = merged[f.key];
      const present = raw !== undefined && raw !== null && raw !== "";
      const value = present
        ? f.secret
          ? maskSecret(String(raw))
          : String(raw)
        : null;
      fields[f.key] = { present, value };
    }
    res.json({
      subAccountId: updated.id,
      crmType: updated.crmType,
      encrypted: true,
      adapterAvailable: true,
      schema: adapter.credentialSchema,
      fields,
    });
  },
);

/**
 * Wipe a sub-account's stored CRM credentials. Useful for offboarding.
 */
router.delete(
  "/admin/sub-accounts/:id/credentials",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [updated] = await db
      .update(subAccounts)
      .set({ crmCredentials: {}, updatedAt: new Date() })
      .where(eq(subAccounts.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ subAccountId: updated.id, cleared: true });
  },
);

/**
 * Run the adapter's no-op test against the live CRM and return the
 * outcome. Used by the "Test connection" button in the admin UI.
 */
router.post(
  "/admin/sub-accounts/:id/credentials/test",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [sub] = await db.select().from(subAccounts).where(eq(subAccounts.id, id)).limit(1);
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const adapter = getCrmAdapter(sub.crmType);
    if (!adapter) {
      res.status(400).json({
        ok: false,
        message: `No adapter for crmType ${sub.crmType ?? "(none)"}`,
      });
      return;
    }
    const creds = decodeStoredCredentials<Record<string, unknown>>(
      sub.crmCredentials ?? {},
    );
    const result = await adapter.testConnection(creds);
    res.status(result.ok ? 200 : 400).json(result);
  },
);

/**
 * Lists the credential schema for every supported CRM. Lets the admin UI
 * render the right form before any sub-account has a CRM type chosen.
 */
router.get("/admin/crm-credential-schemas", requirePlatformAdmin, (_req, res) => {
  const out = listCrmAdapters().map((a) => ({
    crmType: a.type,
    fields: a.credentialSchema,
  }));
  res.json(out);
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

router.post(
  "/admin/enrichment-sources/:source/reset-spend",
  requirePlatformAdmin,
  async (req, res) => {
    const source = parseSource(String(req.params.source));
    if (!source) {
      res.status(400).json({ error: "invalid_source" });
      return;
    }
    if ((FREE_ENRICHMENT_SOURCES as readonly string[]).includes(source)) {
      res.status(400).json({ error: "free_source_has_no_spend" });
      return;
    }
    const now = new Date();
    await db
      .insert(enrichmentSourceApprovals)
      .values({
        source,
        approved: false,
        currentMonthSpend: 0,
        lastResetAt: now,
      })
      .onConflictDoUpdate({
        target: enrichmentSourceApprovals.source,
        set: {
          currentMonthSpend: 0,
          lastResetAt: now,
          updatedAt: now,
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

// ── Webhook configuration helpers ─────────────────────────────────────────

router.get(
  "/admin/sub-accounts/:id/webhook-config",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [sub] = await db
      .select()
      .from(subAccounts)
      .where(eq(subAccounts.id, id))
      .limit(1);
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const creds = (sub.crmCredentials ?? {}) as { webhookSecret?: string };
    const secretSet = Boolean(creds.webhookSecret && creds.webhookSecret.length > 0);

    const urls = SUPPORTED_WEBHOOK_CRMS.map((crm) => ({
      crm,
      url: buildWebhookUrl(req, crm, sub.id),
    }));

    // Last received event (any) and last webhook_error for this sub-account's
    // CRM. We scope by accountId + crmType because reply_events doesn't carry
    // sub_account_id; the (account, crm) pair is sufficient since each
    // sub-account owns its own credentials and inbound URL.
    let lastEvent: typeof replyEvents.$inferSelect | null = null;
    let lastError: typeof replyEvents.$inferSelect | null = null;
    if (sub.crmType) {
      const [latest] = await db
        .select()
        .from(replyEvents)
        .where(
          and(
            eq(replyEvents.accountId, sub.accountId),
            eq(replyEvents.crmType, sub.crmType),
          ),
        )
        .orderBy(desc(replyEvents.receivedAt))
        .limit(1);
      lastEvent = latest ?? null;

      const [latestErr] = await db
        .select()
        .from(replyEvents)
        .where(
          and(
            eq(replyEvents.accountId, sub.accountId),
            eq(replyEvents.crmType, sub.crmType),
            eq(replyEvents.eventType, "webhook_error"),
          ),
        )
        .orderBy(desc(replyEvents.receivedAt))
        .limit(1);
      lastError = latestErr ?? null;
    }

    const lastWasError = lastEvent?.eventType === "webhook_error";
    let lastErrorReason: string | null = null;
    if (lastWasError) {
      const payload = (lastEvent?.rawPayload ?? {}) as { reason?: string };
      lastErrorReason = payload.reason ?? null;
    }

    res.json({
      subAccountId: sub.id,
      subAccountName: sub.name,
      crmType: sub.crmType ?? null,
      webhookUrls: urls,
      secretSet,
      lastReceivedAt: lastEvent?.receivedAt ?? null,
      lastEventType: lastEvent?.eventType ?? null,
      lastSignatureOk: lastEvent ? !lastWasError : null,
      lastErrorReason,
      lastErrorAt: lastError?.receivedAt ?? null,
    });
  },
);

router.post(
  "/admin/sub-accounts/:id/webhook-secret/rotate",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [sub] = await db
      .select()
      .from(subAccounts)
      .where(eq(subAccounts.id, id))
      .limit(1);
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // 32 bytes -> 64 hex chars. Plenty of entropy for HMAC-SHA256 keys.
    const newSecret = crypto.randomBytes(32).toString("hex");
    const existing = (sub.crmCredentials ?? {}) as Record<string, unknown>;
    const merged = { ...existing, webhookSecret: newSecret };
    await db
      .update(subAccounts)
      .set({ crmCredentials: merged, updatedAt: new Date() })
      .where(eq(subAccounts.id, id));
    res.json({ webhookSecret: newSecret, rotatedAt: new Date().toISOString() });
  },
);

/**
 * Status snapshot for the CRM credential encryption key. Lets the admin
 * UI tell the operator: which key is primary, whether a previous-key
 * fallback is configured, and how many sub-account credential blobs are
 * still encrypted under the OLD key (and therefore need a rotation pass).
 */
router.get(
  "/admin/encryption-key/status",
  requirePlatformAdmin,
  async (_req, res) => {
    let primaryKid: string;
    try {
      primaryKid = currentKeyId();
    } catch (err) {
      res.status(500).json({
        error: "encryption_key_not_configured",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const prevKid = previousKeyId();

    const rows = await db
      .select({ id: subAccounts.id, creds: subAccounts.crmCredentials })
      .from(subAccounts);

    let total = 0;
    let encryptedCount = 0;
    let needsRotation = 0;
    let plaintextCount = 0;
    let emptyCount = 0;
    for (const r of rows) {
      total++;
      const c = r.creds;
      if (c == null || (typeof c === "object" && Object.keys(c as object).length === 0)) {
        emptyCount++;
        continue;
      }
      if (isEncryptedBlob(c)) {
        encryptedCount++;
        if (blobNeedsRotation(c, primaryKid)) needsRotation++;
      } else {
        plaintextCount++;
      }
    }

    const [lastRun] = await db
      .select({
        runId: crmKeyRotationEvents.runId,
        createdAt: crmKeyRotationEvents.createdAt,
      })
      .from(crmKeyRotationEvents)
      .orderBy(desc(crmKeyRotationEvents.createdAt))
      .limit(1);

    res.json({
      primaryKid,
      previousKid: prevKid,
      previousKeyConfigured: prevKid !== null,
      totalSubAccounts: total,
      encryptedCount,
      needsRotationCount: needsRotation,
      plaintextCount,
      emptyCount,
      lastRunAt: lastRun?.createdAt ?? null,
      lastRunId: lastRun?.runId ?? null,
    });
  },
);

/**
 * Re-encrypt every encrypted `sub_accounts.crm_credentials` blob with
 * the current primary key. Decryption tries the primary key first, then
 * falls back to `CRM_ENCRYPTION_KEY_PREVIOUS` so a rotation can run
 * without downtime: deploy the new key as primary, keep the old one as
 * `CRM_ENCRYPTION_KEY_PREVIOUS`, run this endpoint, then drop the
 * previous-key secret once `needsRotationCount` is zero.
 *
 * Body: { dryRun?: boolean }. In dry-run mode no rows are updated but
 * audit log entries are still written so operators can preview impact.
 */
router.post(
  "/admin/encryption-key/rotate",
  requirePlatformAdmin,
  async (req, res) => {
    let primaryKid: string;
    try {
      primaryKid = currentKeyId();
    } catch (err) {
      res.status(500).json({
        error: "encryption_key_not_configured",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const dryRun = Boolean(req.body?.dryRun);
    const runId = randomUUID();
    const performedBy = req.currentUser?.id ?? null;

    const rows = await db
      .select({ id: subAccounts.id, creds: subAccounts.crmCredentials })
      .from(subAccounts);

    let reEncrypted = 0;
    let alreadyCurrent = 0;
    let skippedPlaintext = 0;
    let failed = 0;
    const failures: Array<{ subAccountId: string; error: string }> = [];

    for (const r of rows) {
      const c = r.creds;
      if (c == null || (typeof c === "object" && Object.keys(c as object).length === 0)) {
        continue; // empty creds, nothing to do
      }

      if (!isEncryptedBlob(c)) {
        // Legacy plaintext row — flag it but don't touch (saving via the
        // credentials editor is the safe way to migrate these).
        skippedPlaintext++;
        await db.insert(crmKeyRotationEvents).values({
          runId,
          subAccountId: r.id,
          status: "skipped_plaintext",
          fromKid: null,
          toKid: primaryKid,
          decryptedWithPrevious: false,
          dryRun,
          performedBy,
        });
        continue;
      }

      const blob = c as EncryptedBlob;
      if (!blobNeedsRotation(blob, primaryKid)) {
        alreadyCurrent++;
        continue;
      }

      try {
        const { value, decryptedWith } = decryptJsonWithFallback<unknown>(blob);
        if (!dryRun) {
          const next = encryptJson(value);
          await db
            .update(subAccounts)
            .set({ crmCredentials: next, updatedAt: new Date() })
            .where(eq(subAccounts.id, r.id));
        }
        reEncrypted++;
        await db.insert(crmKeyRotationEvents).values({
          runId,
          subAccountId: r.id,
          status: "re_encrypted",
          fromKid: blob.kid ?? null,
          toKid: primaryKid,
          decryptedWithPrevious: decryptedWith === "previous",
          dryRun,
          performedBy,
        });
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ subAccountId: r.id, error: msg });
        await db.insert(crmKeyRotationEvents).values({
          runId,
          subAccountId: r.id,
          status: "failed",
          fromKid: blob.kid ?? null,
          toKid: primaryKid,
          decryptedWithPrevious: false,
          dryRun,
          errorMessage: msg.slice(0, 500),
          performedBy,
        });
      }
    }

    res.json({
      runId,
      dryRun,
      primaryKid,
      previousKid: previousKeyId(),
      totalScanned: rows.length,
      reEncrypted,
      alreadyCurrent,
      skippedPlaintext,
      failed,
      failures,
    });
  },
);

/**
 * Recent rotation audit entries. Useful for admins to confirm a rotation
 * actually swept everything before they remove the previous-key secret.
 */
router.get(
  "/admin/encryption-key/rotation-log",
  requirePlatformAdmin,
  async (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 500
      ? Math.floor(rawLimit)
      : 100;
    const rows = await db
      .select()
      .from(crmKeyRotationEvents)
      .orderBy(desc(crmKeyRotationEvents.createdAt))
      .limit(limit);
    res.json(rows);
  },
);

export default router;
