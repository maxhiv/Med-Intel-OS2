/**
 * PaidSourceGate — the single chokepoint for every paid-source call in v2.0.
 *
 * Adapted from the handoff's PaidSourceGate.js. Two adaptations:
 *  - Uses Drizzle + the v2.0 `paid_source_approvals` table (the handoff's
 *    raw-SQL version queried `enrichment_source_approvals`; see PR A for
 *    why v2.0 gets its own per-account×source table).
 *  - `db` is already RLS-scoped per request by rlsTransactionMiddleware,
 *    so approval reads only ever see the caller's own account.
 *
 * The dual gate: a source is callable only when BOTH are true —
 *   1. system gate — the `*_ENABLED` env var (operator kill switch)
 *   2. tenant gate — `paid_source_approvals.approved` for the account
 * If either is false the call is denied with a structured reason and the
 * attempt is written to `paid_source_call_log`.
 */
import { and, eq } from "drizzle-orm";
import { db, paidSourceApprovals, paidSourceCallLog } from "@workspace/db";

const APPROVAL_CACHE_TTL_MS = 30 * 60 * 1000;

/** source_name → env var controlling the system gate. */
const ENV_VAR_MAP: Record<string, string | null> = {
  anthropic_claude_sonnet_4: "ANTHROPIC_API_KEY",
  openrouteservice: "ORS_ENABLED",
  osrm_self_hosted: "OSRM_SELF_HOSTED_URL",
  google_custom_search: "GOOGLE_CSE_ENABLED",
  proxycurl: "PROXYCURL_ENABLED",
  chpl_api: "CHPL_ENABLED",
  newsapi: "NEWSAPI_ENABLED",
  adzuna: "ADZUNA_ENABLED",
  jooble: "JOOBLE_ENABLED",
  usajobs: "USAJOBS_ENABLED",
  outscraper: "OUTSCRAPER_ENABLED",
  searchatlas: "SEARCHATLAS_ENABLED",
  doximity: "DOXIMITY_ENABLED",
  docgraph_caresets: null, // file-licensed; approval row only
};

/** Sources whose env var enables on presence (any value) vs literal "true". */
const PRESENCE_GATED = new Set(["anthropic_claude_sonnet_4", "osrm_self_hosted"]);

export type GateReason = "denied_env" | "denied_approval";

export interface GateAuditFields {
  accountId: string;
  userId?: string | null;
  sourceName: string;
  sourceCategory: string;
  toolName: string;
  sessionId?: string | null;
}

export interface GateCheckResult {
  allowed: boolean;
  reason?: GateReason;
  userMessage?: string;
  audit: GateAuditFields;
}

export interface LogCallInput extends GateAuditFields {
  requestArgs?: unknown;
  responseStatus: string;
  costUsd?: number;
  latencyMs?: number;
  errorMessage?: string;
}

function categoryFor(sourceName: string): string {
  if (sourceName === "anthropic_claude_sonnet_4") return "anthropic_agent";
  if (
    ["openrouteservice", "osrm_self_hosted", "google_custom_search", "proxycurl", "chpl_api", "newsapi"].includes(
      sourceName,
    )
  ) {
    return "open_informatics_mcp";
  }
  return "medintel_proprietary";
}

export class PaidSourceGate {
  private env: NodeJS.ProcessEnv;
  /** key `${accountId}:${sourceName}` → { approved, fetchedAt } */
  private approvalCache = new Map<string, { approved: boolean; fetchedAt: number }>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  /** Is the system-level env gate open for this source? */
  private envOpen(sourceName: string): boolean {
    const envVar = ENV_VAR_MAP[sourceName];
    if (envVar === null || envVar === undefined) return true; // no env gate
    const value = this.env[envVar];
    return PRESENCE_GATED.has(sourceName) ? Boolean(value) : value === "true";
  }

  /** Dual-gate check. Always pair the result with logCall(). */
  async check(input: {
    sourceName: string;
    accountId: string;
    userId?: string | null;
    toolName?: string;
    sessionId?: string | null;
  }): Promise<GateCheckResult> {
    const { sourceName, accountId } = input;
    if (!sourceName) throw new Error("sourceName is required");
    if (!accountId) throw new Error("accountId is required (RLS prerequisite)");

    const audit: GateAuditFields = {
      accountId,
      userId: input.userId ?? null,
      sourceName,
      sourceCategory: categoryFor(sourceName),
      toolName: input.toolName ?? sourceName,
      sessionId: input.sessionId ?? null,
    };

    if (!this.envOpen(sourceName)) {
      const envVar = ENV_VAR_MAP[sourceName];
      return {
        allowed: false,
        reason: "denied_env",
        userMessage: `The ${sourceName} integration is not enabled at the system level. An operator must set ${envVar} before this source is available.`,
        audit,
      };
    }

    if (!(await this.getApproval(accountId, sourceName))) {
      return {
        allowed: false,
        reason: "denied_approval",
        userMessage: `The ${sourceName} integration is enabled system-wide but not approved for this account. An account admin must approve it in Settings → Paid Sources.`,
        audit,
      };
    }

    return { allowed: true, audit };
  }

  /** Append one row to paid_source_call_log. Call after every check(). */
  async logCall(input: LogCallInput): Promise<void> {
    await db.insert(paidSourceCallLog).values({
      accountId: input.accountId,
      userId: input.userId ?? null,
      sourceName: input.sourceName,
      sourceCategory: input.sourceCategory,
      toolName: input.toolName,
      requestArgs: (input.requestArgs ?? null) as Record<string, unknown> | null,
      responseStatus: input.responseStatus,
      costUsd: String(input.costUsd ?? 0),
      latencyMs: input.latencyMs ?? null,
      errorMessage: input.errorMessage ?? null,
      sessionId: input.sessionId ?? null,
    });
  }

  /** Drop cached approvals for an account (or all). Call after setApproval. */
  invalidateCache(accountId?: string): void {
    if (!accountId) {
      this.approvalCache.clear();
      return;
    }
    for (const key of this.approvalCache.keys()) {
      if (key.startsWith(`${accountId}:`)) this.approvalCache.delete(key);
    }
  }

  /** Full per-source approval matrix for an account, annotated with env state. */
  async listApprovals(accountId: string) {
    const rows = await db
      .select()
      .from(paidSourceApprovals)
      .where(eq(paidSourceApprovals.accountId, accountId));

    return rows
      .map((row) => {
        const envVar = ENV_VAR_MAP[row.sourceName];
        const envEnabled = envVar === null || envVar === undefined ? null : this.envOpen(row.sourceName);
        return {
          sourceName: row.sourceName,
          sourceCategory: row.sourceCategory,
          sourceTier: row.sourceTier,
          approved: row.approved,
          estimatedMonthlyCostUsd: row.estimatedMonthlyCostUsd,
          notes: row.notes,
          approvalChangedAt: row.approvalChangedAt,
          envVar: envVar ?? null,
          envEnabled,
          callableNow: envEnabled === true && row.approved === true,
        };
      })
      .sort((a, b) => a.sourceName.localeCompare(b.sourceName));
  }

  /** Flip a tenant's approval for a source. Invalidates the cache. */
  async setApproval(input: {
    accountId: string;
    sourceName: string;
    approved: boolean;
    userId?: string | null;
    notes?: string | null;
  }): Promise<{ updated: boolean }> {
    const result = await db
      .update(paidSourceApprovals)
      .set({
        approved: input.approved,
        approvedByUserId: input.userId ?? null,
        approvalChangedAt: new Date(),
        ...(input.notes != null ? { notes: input.notes } : {}),
      })
      .where(
        and(
          eq(paidSourceApprovals.accountId, input.accountId),
          eq(paidSourceApprovals.sourceName, input.sourceName),
        ),
      )
      .returning({ id: paidSourceApprovals.id });
    this.invalidateCache(input.accountId);
    return { updated: result.length > 0 };
  }

  private async getApproval(accountId: string, sourceName: string): Promise<boolean> {
    const key = `${accountId}:${sourceName}`;
    const cached = this.approvalCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < APPROVAL_CACHE_TTL_MS) {
      return cached.approved;
    }
    const [row] = await db
      .select({ approved: paidSourceApprovals.approved })
      .from(paidSourceApprovals)
      .where(
        and(
          eq(paidSourceApprovals.accountId, accountId),
          eq(paidSourceApprovals.sourceName, sourceName),
        ),
      )
      .limit(1);
    const approved = row?.approved === true;
    this.approvalCache.set(key, { approved, fetchedAt: Date.now() });
    return approved;
  }
}

/** Process-wide singleton — the approval cache is shared across requests. */
export const paidSourceGate = new PaidSourceGate();
