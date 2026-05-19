import crypto, { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { eq, sql, desc, and, ilike, or } from "drizzle-orm";
import {
  db,
  accounts,
  users,
  subAccounts,
  accountFacilities,
  enrichmentSourceApprovals,
  facilities,
  purchaseSignals,
  outreachDrafts,
  facilityContacts,
  syncBatches,
  contactValidationLog,
  replyEvents,
  crmKeyRotationEvents,
  conFilings,
  FREE_ENRICHMENT_SOURCES,
  PAID_ENRICHMENT_SOURCES,
} from "@workspace/db";
import { getReviewThreshold } from "../services/conFilingsIngestor";
import { recomputeAllScores } from "../services/signalScorer";
import { seedParentSystems } from "@workspace/db";
import { propagateSystemSignals } from "../services/systemSignalPropagator";
import { requirePlatformAdmin } from "../middlewares/auth";
import { listAllSources } from "../services/enrichment";
import { backfillConFilingFacilities } from "../services/conFacilityMatcher";
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
import { runImport990 } from "../services/import990Runner";
import {
  startNationalIngest,
  nationalIngestJob,
  TOP_20_STATES,
  ALL_50_STATES,
} from "../services/nationalIngest";
import { nationalIngestRuns } from "@workspace/db";

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

// ---------------------------------------------------------------------------
// Cross-account facility search (for reassignment UI)
// ---------------------------------------------------------------------------

router.get(
  "/admin/facilities/search",
  requirePlatformAdmin,
  async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      res.status(400).json({ error: "q_min_length_2" });
      return;
    }
    const stateRaw =
      typeof req.query.state === "string" ? req.query.state.trim().toUpperCase() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const pattern = `%${q}%`;

    const conds = [
      or(
        ilike(facilities.name, pattern),
        ilike(facilities.doingBusinessAs, pattern),
        ilike(facilities.systemName, pattern),
        ilike(facilities.npi, pattern),
      )!,
    ];
    if (stateRaw.length === 2) conds.push(eq(facilities.state, stateRaw));

    const rows = await db
      .select({
        id: facilities.id,
        name: facilities.name,
        doingBusinessAs: facilities.doingBusinessAs,
        systemName: facilities.systemName,
        city: facilities.city,
        state: facilities.state,
        npi: facilities.npi,
      })
      .from(facilities)
      .where(and(...conds))
      .orderBy(facilities.name)
      .limit(limit);
    res.json(rows);
  },
);

/**
 * Link every facility in the database to every account. Idempotent —
 * uses ON CONFLICT DO NOTHING. After linking, triggers a full score
 * recompute so dashboards immediately reflect the newly visible data.
 *
 * Returns { linked, skipped, errors } — counts of net-new rows inserted,
 * pairs that already existed (skipped via ON CONFLICT), and any SQL errors.
 */
router.post(
  "/admin/facilities/link-all",
  requirePlatformAdmin,
  async (_req, res) => {
    // Count total possible (account, facility) pairs before inserting so we
    // can derive how many were already linked (skipped).
    const [totRow] = await db.execute(sql`
      SELECT (SELECT COUNT(*) FROM accounts) * (SELECT COUNT(*) FROM facilities) AS total,
             (SELECT COUNT(*) FROM account_facilities) AS existing
    `) as unknown as Array<{ total: string; existing: string }>;

    const totalPossible = Number(totRow?.total ?? 0);
    const existingBefore = Number(totRow?.existing ?? 0);

    const result = await db.execute(sql`
      INSERT INTO account_facilities (account_id, facility_id)
      SELECT a.id, f.id
      FROM accounts a
      CROSS JOIN facilities f
      ON CONFLICT (account_id, facility_id) DO NOTHING
    `);
    const linked = Number((result as { rowCount?: number }).rowCount ?? 0);
    const skipped = Math.max(0, totalPossible - existingBefore - linked);

    recomputeAllScores().catch(() => {});
    res.json({ linked, skipped, errors: 0 });
  },
);

router.post(
  "/admin/con-filings/backfill-facilities",
  requirePlatformAdmin,
  async (req, res) => {
    const rawLimit = Number((req.body ?? {}).limit);
    const rawEmit = (req.body ?? {}).emitSignals;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 1000;
    const emitSignals = rawEmit === false ? false : true;
    const result = await backfillConFilingFacilities({ limit, emitSignals });
    res.json(result);
  },
);


// ---------------------------------------------------------------------------
// CON-filing match review queue
// ---------------------------------------------------------------------------

/**
 * List CON filings whose auto-emitted facility match landed in the borderline
 * confidence band and is awaiting human review. Newest filings first so the
 * freshest signals get triaged before they pollute outreach.
 */
router.get(
  "/admin/con-filings/review-queue",
  requirePlatformAdmin,
  async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const rows = await db
      .select({
        id: conFilings.id,
        facilityId: conFilings.facilityId,
        facilityName: facilities.name,
        facilitySystem: facilities.systemName,
        facilityCity: facilities.city,
        facilityState: facilities.state,
        state: conFilings.state,
        applicantName: conFilings.applicantName,
        filingDate: conFilings.filingDate,
        filingUrl: conFilings.filingUrl,
        modality: conFilings.modality,
        equipmentType: conFilings.equipmentType,
        status: conFilings.status,
        matchScore: conFilings.matchScore,
        matchField: conFilings.matchField,
        reviewStatus: conFilings.reviewStatus,
        createdAt: conFilings.createdAt,
      })
      .from(conFilings)
      .leftJoin(facilities, eq(facilities.id, conFilings.facilityId))
      .where(eq(conFilings.reviewStatus, "needs_review"))
      .orderBy(
        desc(sql`COALESCE(${conFilings.filingDate}, ${conFilings.createdAt}::date)`),
      )
      .limit(limit)
      .offset(offset);

    const [{ c: total }] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(conFilings)
      .where(eq(conFilings.reviewStatus, "needs_review"));

    res.json({
      data: rows.map((r) => ({
        ...r,
        matchScore: r.matchScore == null ? null : Number(r.matchScore),
      })),
      total,
      limit,
      offset,
      reviewThreshold: getReviewThreshold(),
    });
  },
);

/**
 * Take action on a borderline CON-filing match.
 *
 * Body: `{ action: "confirm" | "reject" | "reassign", facilityId?, notes? }`
 *
 *   confirm   — accept the auto-match as-is. Filing's signal stays active.
 *   reject    — strike the match. We null out facilityId and deactivate the
 *               auto-emitted purchase signal so it stops polluting outreach.
 *   reassign  — swap to a different facility. Old signal is deactivated and a
 *               fresh one is emitted against the new facility (if not already).
 */
router.post(
  "/admin/con-filings/:id/review",
  requirePlatformAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const action = String(req.body?.action ?? "");
    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.slice(0, 1000) : null;
    const reviewerId = req.currentUser?.id ?? null;

    if (!["confirm", "reject", "reassign"].includes(action)) {
      res.status(400).json({ error: "invalid_action" });
      return;
    }

    const [filing] = await db
      .select()
      .from(conFilings)
      .where(eq(conFilings.id, id))
      .limit(1);
    if (!filing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const now = new Date();

    if (action === "confirm") {
      const [updated] = await db
        .update(conFilings)
        .set({
          reviewStatus: "confirmed",
          reviewedAt: now,
          reviewedBy: reviewerId,
          reviewNotes: notes,
        })
        .where(eq(conFilings.id, id))
        .returning();
      res.json(updated);
      return;
    }

    if (action === "reject") {
      // Deactivate the auto-emitted signal that was tied to this filing.
      if (filing.facilityId) {
        await db
          .update(purchaseSignals)
          .set({ isActive: false })
          .where(eq(purchaseSignals.sourceId, filing.id));
      }
      const [updated] = await db
        .update(conFilings)
        .set({
          facilityId: null,
          reviewStatus: "rejected",
          reviewedAt: now,
          reviewedBy: reviewerId,
          reviewNotes: notes,
        })
        .where(eq(conFilings.id, id))
        .returning();
      res.json(updated);
      return;
    }

    // reassign
    const newFacilityId =
      typeof req.body?.facilityId === "string" ? req.body.facilityId : null;
    if (!newFacilityId) {
      res.status(400).json({ error: "facilityId_required_for_reassign" });
      return;
    }
    const [target] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.id, newFacilityId))
      .limit(1);
    if (!target) {
      res.status(400).json({ error: "facility_not_found" });
      return;
    }

    // Deactivate any existing auto-emitted signal for this filing — its
    // facilityId is about to change, so the old signal is now wrong.
    await db
      .update(purchaseSignals)
      .set({ isActive: false })
      .where(eq(purchaseSignals.sourceId, filing.id));

    // Emit a fresh signal against the new facility, mirroring the ingestor's
    // logic. Re-derive the type from raw status text so an "approved" filing
    // still surfaces as `con_approved` after reassignment.
    const isApproved = !!filing.status && /approv|grant(ed)?|issued/i.test(filing.status);
    const signalType = isApproved ? "con_approved" : "con_filed";
    const [sigExists] = await db
      .select({ id: purchaseSignals.id })
      .from(purchaseSignals)
      .where(
        sql`${purchaseSignals.facilityId} = ${target.id}
            AND ${purchaseSignals.signalType} = ${signalType}
            AND ${purchaseSignals.signalValue} = ${filing.filingUrl}`,
      )
      .limit(1);
    if (!sigExists) {
      await db.insert(purchaseSignals).values({
        facilityId: target.id,
        signalType,
        signalValue: filing.filingUrl,
        confidence: isApproved ? 90 : 75,
        source: "con_filing",
        sourceId: filing.id,
        isActive: true,
      });
    } else {
      // Re-activate in case it was previously deactivated by an earlier review.
      await db
        .update(purchaseSignals)
        .set({ isActive: true })
        .where(eq(purchaseSignals.id, sigExists.id));
    }

    const [updated] = await db
      .update(conFilings)
      .set({
        facilityId: target.id,
        reviewStatus: "reassigned",
        reviewedAt: now,
        reviewedBy: reviewerId,
        reviewNotes: notes,
      })
      .where(eq(conFilings.id, id))
      .returning();
    res.json(updated);
  },
);

// ─── Parent system seeding ───────────────────────────────────────────────────

router.post(
  "/admin/facilities/seed-parent-systems",
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result = await seedParentSystems();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "seed_failed", detail: String(err) });
    }
  },
);

// ─── System signal propagation ───────────────────────────────────────────────

router.post(
  "/admin/signals/propagate-system",
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result = await propagateSystemSignals();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "propagation_failed", detail: String(err) });
    }
  },
);

// ─── Signal coverage by state ─────────────────────────────────────────────────
//
// GET /admin/signal-coverage[?states=IL,TX]
//
// Returns per-state counts of total facilities, scraped facilities, and
// facilities that have at least one active signal.  Accessible via platform
// admin Clerk session OR the INTERNAL_ADMIN_KEY header (for the bulk-ingest
// script which runs outside a browser session).

router.get("/admin/signal-coverage", async (req, res) => {
  const internalKey = process.env.INTERNAL_ADMIN_KEY;
  const providedKey = req.headers["x-internal-admin-key"];
  const isInternalCaller = internalKey && providedKey === internalKey;

  if (!isInternalCaller) {
    if (!req.currentUser) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (!req.isPlatformAdmin) { res.status(403).json({ error: "forbidden" }); return; }
  }

  const statesQs = typeof req.query.states === "string" ? req.query.states.trim() : "";
  const filterStates = statesQs
    ? statesQs.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [];

  try {
    // Build the per-state aggregation via raw SQL for efficiency.
    const stateFilter = filterStates.length > 0
      ? sql`WHERE f.state = ANY(ARRAY[${sql.raw(filterStates.map((s) => `'${s.replace(/'/g, "")}'`).join(","))}])`
      : sql`WHERE f.state IS NOT NULL`;

    type CoverageRow = { state: string; total: number; scraped: number; with_signals: number };

    const result = await db.execute<CoverageRow>(sql`
      SELECT
        f.state,
        COUNT(*)::int                                               AS total,
        COUNT(*) FILTER (WHERE f.last_scraped_at IS NOT NULL)::int AS scraped,
        COUNT(DISTINCT ps.facility_id)::int                        AS with_signals
      FROM facilities f
      LEFT JOIN purchase_signals ps
        ON ps.facility_id = f.id AND ps.is_active = true
      ${stateFilter}
      GROUP BY f.state
      ORDER BY f.state
    `);

    const coverage = (result.rows as CoverageRow[]).map((r) => ({
      state: r.state,
      total: Number(r.total),
      scraped: Number(r.scraped),
      withSignals: Number(r.with_signals),
    }));

    const totals = coverage.reduce(
      (acc, r) => ({
        total: acc.total + r.total,
        scraped: acc.scraped + r.scraped,
        withSignals: acc.withSignals + r.withSignals,
      }),
      { total: 0, scraped: 0, withSignals: 0 },
    );

    res.json({ coverage, totals });
  } catch (err) {
    res.status(500).json({ error: "query_failed", detail: String(err) });
  }
});

// ─── IRS 990 import trigger ───────────────────────────────────────────────────
//
// POST /admin/run-990-import
//   Kicks off the full 7-phase IRS 990 pipeline in the background and returns
//   202 Accepted immediately (the import takes ~100 s).
//   Returns 409 if an import is already running (single-flight guard).
//
// GET /admin/990-import/status
//   Returns the status of the latest import job (running / done / failed / idle).
//
// Auth: INTERNAL_ADMIN_KEY header only.
//
// Optional POST body:
//   { signalsOnly: true }  — skip Phase 1 CSV import; re-run phases 2-7 only.
//   { zipPath: "/abs/path" } — override the ZIP source path.

interface Import990Job {
  status: "running" | "done" | "failed" | "idle";
  startedAt: string | null;
  finishedAt: string | null;
  signalsOnly: boolean;
  zipPath: string | null;
  result: import("../services/import990Runner").Import990Result | null;
  error: string | null;
}

const import990Job: Import990Job = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  signalsOnly: false,
  zipPath: null,
  result: null,
  error: null,
};

function requireInternalAdminKey(req: import("express").Request, res: import("express").Response): boolean {
  const internalKey = process.env.INTERNAL_ADMIN_KEY;
  const providedKey = req.headers["x-internal-admin-key"];
  if (!internalKey || providedKey !== internalKey) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

router.post("/admin/run-990-import", async (req, res) => {
  if (!requireInternalAdminKey(req, res)) return;

  if (import990Job.status === "running") {
    res.status(409).json({
      error: "import_already_running",
      startedAt: import990Job.startedAt,
    });
    return;
  }

  // Strict boolean: only the literal `true` value enables signalsOnly mode.
  const rawSignalsOnly = (req.body ?? {}).signalsOnly;
  const signalsOnly    = rawSignalsOnly === true;
  const zipPath        = typeof (req.body ?? {}).zipPath === "string"
    ? String((req.body as { zipPath: string }).zipPath)
    : null;

  Object.assign(import990Job, {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    signalsOnly,
    zipPath,
    result: null,
    error: null,
  });

  res.status(202).json({
    ok: true,
    message: "IRS 990 import started in background",
    signalsOnly,
    zipPath,
    statusUrl: "/api/admin/990-import/status",
  });

  runImport990({ signalsOnly, zipPath: zipPath ?? undefined }).then((result) => {
    Object.assign(import990Job, {
      status: "done",
      finishedAt: new Date().toISOString(),
      result,
      error: null,
    });
    console.log(
      `[run-990-import] Completed: ${result.signals.total} signals, ` +
      `${result.directMatched + result.trgmMatched} facilities matched, ` +
      `${(result.elapsedMs / 1000).toFixed(1)}s elapsed`,
    );
  }).catch((err: unknown) => {
    Object.assign(import990Job, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: String(err),
    });
    console.error("[run-990-import] Pipeline failed:", String(err));
  });
});

router.get("/admin/990-import/status", (req, res) => {
  if (!requireInternalAdminKey(req, res)) return;
  res.json(import990Job);
});

// POST /admin/seed-account-facilities
//
// One-time utility: inserts a row in account_facilities for every
// (account, facility) pair that doesn't already exist.  This gives every
// tenant full visibility of all facilities without needing the multi-tenant
// routing logic to be finalised first.
// Auth: INTERNAL_ADMIN_KEY header only.

router.post("/admin/seed-account-facilities", async (req, res) => {
  const internalKey = process.env.INTERNAL_ADMIN_KEY;
  const providedKey = req.headers["x-internal-admin-key"];
  if (!internalKey || providedKey !== internalKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    // Bulk-insert in one statement using a cross-join between accounts and
    // facilities, skipping pairs that already exist.
    const result = await db.execute(sql`
      INSERT INTO account_facilities (account_id, facility_id)
      SELECT a.id, f.id
      FROM accounts a
      CROSS JOIN facilities f
      WHERE NOT EXISTS (
        SELECT 1 FROM account_facilities af
        WHERE af.account_id = a.id AND af.facility_id = f.id
      )
      ON CONFLICT DO NOTHING
    `);

    const inserted: number = (result as unknown as { rowCount: number }).rowCount ?? 0;
    res.json({ ok: true, inserted });
  } catch (err) {
    res.status(500).json({ error: "seed_failed", detail: String(err) });
  }
});

// ─── National Ingest trigger ──────────────────────────────────────────────────
//
// POST /api/admin/ingest/national
//   Spawns a full national ingest round in the background.
//   Auth: requirePlatformAdmin (Clerk platform-admin role).
//   Body params (all optional):
//     allStates   boolean   true → all 50 states, false/omitted → top-20
//     states      string[]  explicit state list (overrides allStates)
//     limit       number    facilities per source (default 500, max 2000)
//
// GET /api/admin/ingest/status
//   Returns current job state + signal coverage by state and source.
//   Auth: requirePlatformAdmin.

router.post(
  "/admin/ingest/national",
  requirePlatformAdmin,
  async (req, res) => {
    if (nationalIngestJob.status === "running") {
      res.status(409).json({ alreadyRunning: true, job: nationalIngestJob });
      return;
    }

    const body = req.body ?? {};
    let states: string[] | undefined;
    if (Array.isArray(body.states) && body.states.length > 0) {
      states = (body.states as unknown[])
        .map((s) => String(s).toUpperCase().trim())
        .filter(Boolean);
    } else if (body.allStates === true) {
      states = ALL_50_STATES;
    }
    // If nothing specified, nationalIngest.ts defaults to TOP_20_STATES.

    const limit =
      typeof body.limit === "number" && body.limit > 0
        ? Math.min(Math.round(body.limit), 2000)
        : 500;

    const { started, job } = startNationalIngest({
      states,
      limit,
      recomputeScores: body.recomputeScores !== false,
    });

    // One-round batch mode: runs every ingestor once across the target states.
    // Re-trigger from the UI (or schedule via cron) to continue coverage.
    res.status(started ? 202 : 409).json({ started, job, roundMode: "single" });
  },
);

router.get(
  "/admin/ingest/status",
  requirePlatformAdmin,
  async (_req, res) => {
    // Signal coverage by source
    const bySource = await db.execute<{ source: string; count: string }>(sql.raw(`
      SELECT source, COUNT(*)::int AS count
      FROM purchase_signals
      WHERE is_active = true
      GROUP BY source
      ORDER BY count DESC
    `));

    // Signal coverage by state — all states, no LIMIT so national visibility is complete.
    const byState = await db.execute<{
      state: string;
      total_facilities: string;
      facilities_with_signals: string;
      total_signals: string;
    }>(sql.raw(`
      SELECT
        f.state,
        COUNT(DISTINCT f.id)::int            AS total_facilities,
        COUNT(DISTINCT ps.facility_id)::int  AS facilities_with_signals,
        COUNT(ps.id)::int                    AS total_signals
      FROM facilities f
      LEFT JOIN purchase_signals ps
        ON ps.facility_id = f.id AND ps.is_active = true
      GROUP BY f.state
      ORDER BY total_signals DESC
    `));

    // Last 20 completed nightly runs (newest first)
    const recentRuns = await db
      .select()
      .from(nationalIngestRuns)
      .orderBy(desc(nationalIngestRuns.startedAt))
      .limit(20);

    res.json({
      job: nationalIngestJob,
      top20States: TOP_20_STATES,
      recentRuns,
      bySource: (bySource.rows as { source: string; count: string }[]).map((r) => ({
        source: r.source,
        count: Number(r.count),
      })),
      byState: (byState.rows as {
        state: string;
        total_facilities: string;
        facilities_with_signals: string;
        total_signals: string;
      }[]).map((r) => ({
        state: r.state,
        totalFacilities: Number(r.total_facilities),
        facilitiesWithSignals: Number(r.facilities_with_signals),
        totalSignals: Number(r.total_signals),
      })),
    });
  },
);

export default router;
