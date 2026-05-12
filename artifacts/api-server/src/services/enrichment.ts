/**
 * Contact enrichment waterfall.
 *
 * Two-gate model for paid sources: a paid source is "active" only when
 * (a) PAID_ENRICHMENT_<UPPER_SOURCE>_ENABLED env var is "true",
 * (b) the corresponding API key env var is present, AND
 * (c) the database `enrichment_source_approvals.approved` row is true.
 *
 * Free sources are always available. Free adapters apply a small confidence
 * boost without making external calls (the heavy ingestion lives in dedicated
 * services like `npiSync` and `clinicalTrialsIngestor`).
 *
 * The ZeroBounce paid adapter is fully wired: when active it makes real HTTP
 * calls with retries, records per-call cost in micros to
 * `contact_validation_log.cost_micros`, and increments
 * `enrichment_source_approvals.current_month_spend` so platform admins can see
 * burn against any configured monthly budget.
 *
 * Bouncer (usebouncer.com) is wired as a backup paid validator using the same
 * shape. In a single enrichment pass, ZeroBounce runs first; Bouncer is
 * invoked only when ZeroBounce returned its `status: error` envelope (or was
 * not active at all). This gives ops automatic failover when ZeroBounce is
 * down or out of quota, without double-billing on the happy path.
 */
import { eq, sql } from "drizzle-orm";
import {
  db,
  facilityContacts,
  contactValidationLog,
  enrichmentSourceApprovals,
  FREE_ENRICHMENT_SOURCES,
  PAID_ENRICHMENT_SOURCES,
  type Contact,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  validateEmail as zbValidateEmail,
  ZEROBOUNCE_COST_MICROS,
} from "./adapters/zerobounce";
import {
  validateEmail as bouncerValidateEmail,
  BOUNCER_COST_MICROS,
} from "./adapters/bouncer";
import { rolloverSpendCounters } from "./monthRollover";

export type EnrichmentSourceKey =
  | (typeof FREE_ENRICHMENT_SOURCES)[number]
  | (typeof PAID_ENRICHMENT_SOURCES)[number];

const PAID_KEY_ENV: Record<string, string> = {
  apollo: "APOLLO_API_KEY",
  netrows: "NETROWS_API_KEY",
  zerobounce: "ZEROBOUNCE_API_KEY",
  bouncer: "BOUNCER_API_KEY",
  twilio: "TWILIO_AUTH_TOKEN",
  people_data_labs: "PEOPLE_DATA_LABS_API_KEY",
  zoominfo: "ZOOMINFO_API_KEY",
  definitive_hc: "DEFINITIVE_HC_API_KEY",
  openpermit: "OPENPERMIT_API_KEY",
};

export interface SourceStatus {
  source: EnrichmentSourceKey;
  isFreeSource: boolean;
  envEnabled: boolean;
  envKeyPresent: boolean;
  approved: boolean;
  approvedAt: Date | null;
  approvedBy: string | null;
  /** Cents spent against this source so far this billing month. */
  monthSpendCents: number;
  /** Hard monthly budget cap in cents (null = no cap configured). */
  monthBudgetCents: number | null;
  /** Raw micros values used for precise budget gating. */
  monthSpendMicros: number;
  monthBudgetMicros: number | null;
  /**
   * True when this paid source has hit or exceeded its configured monthly
   * budget cap and should be skipped by the enrichment waterfall until the
   * counter resets or the cap is raised.
   */
  autoPaused: boolean;
}

function envEnabledFor(source: string): boolean {
  if ((FREE_ENRICHMENT_SOURCES as readonly string[]).includes(source)) {
    return true;
  }
  const key = `PAID_ENRICHMENT_${source.toUpperCase()}_ENABLED`;
  return process.env[key] === "true";
}

function envKeyPresentFor(source: string): boolean {
  if ((FREE_ENRICHMENT_SOURCES as readonly string[]).includes(source)) {
    return true;
  }
  const key = PAID_KEY_ENV[source];
  return key ? Boolean(process.env[key]) : false;
}

export async function listAllSources(): Promise<SourceStatus[]> {
  // Lazy reset: if the calendar month has rolled over since the last write,
  // archive and zero stale counters before reading them so the admin
  // dashboard never shows last month's accumulated total.
  await rolloverSpendCounters();
  const approvals = await db.select().from(enrichmentSourceApprovals);
  const approvalMap = new Map(approvals.map((a) => [a.source, a]));

  const all: EnrichmentSourceKey[] = [
    ...FREE_ENRICHMENT_SOURCES,
    ...PAID_ENRICHMENT_SOURCES,
  ];

  return all.map((source) => {
    const isFree = (FREE_ENRICHMENT_SOURCES as readonly string[]).includes(
      source,
    );
    const a = approvalMap.get(source);
    const spendMicros = a?.currentMonthSpend ?? 0;
    const budgetMicros = a?.monthlyBudgetLimit ?? null;
    const autoPaused =
      !isFree && budgetMicros != null && spendMicros >= budgetMicros;
    return {
      source,
      isFreeSource: isFree,
      envEnabled: envEnabledFor(source),
      envKeyPresent: envKeyPresentFor(source),
      approved: isFree ? true : Boolean(a?.approved),
      approvedAt: a?.approvedAt ?? null,
      approvedBy: a?.approvedBy ?? null,
      monthSpendCents: Math.round(spendMicros / 10_000),
      monthBudgetCents:
        budgetMicros == null ? null : Math.round(budgetMicros / 10_000),
      monthSpendMicros: spendMicros,
      monthBudgetMicros: budgetMicros,
      autoPaused,
    };
  });
}

function isSourceActive(s: SourceStatus): boolean {
  if (s.isFreeSource) return true;
  return s.envEnabled && s.envKeyPresent && s.approved;
}

function isOverBudget(s: SourceStatus): boolean {
  return s.autoPaused;
}

export interface EnrichResult {
  contactId: string;
  sourcesRun: string[];
  sourcesSkipped: { source: string; reason: string }[];
  confidenceBefore: number;
  confidenceAfter: number;
  finalEmailStatus: string;
  totalCostMicros: number;
}

interface AdapterRun {
  ok: boolean;
  delta: number;
  costMicros: number;
  attempts: number;
  raw: unknown;
  newEmailStatus?: Contact["emailStatus"];
  /**
   * True when the underlying paid adapter returned its explicit "error"
   * envelope (transport failure, bad key, exhausted quota…). Distinguishes
   * a real failure from legitimate non-error verdicts like `unknown` /
   * `risky`, which should be treated as real responses.
   */
  isErrorEnvelope?: boolean;
}

async function runAdapter(
  source: EnrichmentSourceKey,
  contact: Contact,
  isFree: boolean,
): Promise<AdapterRun> {
  // Real paid adapter: ZeroBounce email validation.
  if (source === "zerobounce") {
    if (!contact.email) {
      return {
        ok: false,
        delta: 0,
        costMicros: 0,
        attempts: 0,
        raw: { skipped: "no_email" },
      };
    }
    const apiKey = process.env.ZEROBOUNCE_API_KEY!;
    const r = await zbValidateEmail(contact.email, { apiKey });
    let newStatus: Contact["emailStatus"] | undefined;
    if (r.status === "valid") newStatus = "verified";
    else if (r.status === "invalid") newStatus = "bounced";
    return {
      ok: r.ok,
      delta: r.confidenceDelta,
      // Only successful (non-error) calls are billed. ZeroBounce returns the
      // error envelope without consuming credit when keys/quota are bad.
      costMicros: r.status === "error" ? 0 : ZEROBOUNCE_COST_MICROS,
      attempts: r.attempts,
      raw: r.raw,
      newEmailStatus: newStatus,
      isErrorEnvelope: r.status === "error",
    };
  }

  // Real paid adapter: Bouncer email validation (backup to ZeroBounce).
  if (source === "bouncer") {
    if (!contact.email) {
      return {
        ok: false,
        delta: 0,
        costMicros: 0,
        attempts: 0,
        raw: { skipped: "no_email" },
      };
    }
    const apiKey = process.env.BOUNCER_API_KEY!;
    const r = await bouncerValidateEmail(contact.email, { apiKey });
    let newStatus: Contact["emailStatus"] | undefined;
    if (r.status === "deliverable") newStatus = "verified";
    else if (r.status === "undeliverable") newStatus = "bounced";
    return {
      ok: r.ok,
      delta: r.confidenceDelta,
      // Bouncer (like ZeroBounce) returns an error envelope without consuming
      // credit when the key/quota is bad, so only bill non-error responses.
      costMicros: r.status === "error" ? 0 : BOUNCER_COST_MICROS,
      attempts: r.attempts,
      raw: r.raw,
      newEmailStatus: newStatus,
      isErrorEnvelope: r.status === "error",
    };
  }

  // All other sources currently apply a small confidence delta. Replacing
  // these with real adapters follows the same pattern as ZeroBounce.
  const delta = isFree ? 4 : 10;
  return {
    ok: true,
    delta,
    costMicros: 0,
    attempts: 1,
    raw: { stub: true, source },
  };
}

async function recordSpend(
  source: EnrichmentSourceKey,
  costMicros: number,
): Promise<void> {
  if (costMicros <= 0) return;
  // Lazy reset before mutating the counter so a payment that lands on the
  // first call of a new month gets credited to the new period instead of
  // bumping last month's stale total.
  await rolloverSpendCounters();
  await db
    .insert(enrichmentSourceApprovals)
    .values({
      source,
      approved: false,
      currentMonthSpend: costMicros,
    })
    .onConflictDoUpdate({
      target: enrichmentSourceApprovals.source,
      set: {
        currentMonthSpend: sql`COALESCE(${enrichmentSourceApprovals.currentMonthSpend}, 0) + ${costMicros}`,
        updatedAt: new Date(),
      },
    });
}

export async function enrichContact(
  contactId: string,
  opts: { dryRun?: boolean } = {},
): Promise<EnrichResult> {
  const [contact] = await db
    .select()
    .from(facilityContacts)
    .where(eq(facilityContacts.id, contactId))
    .limit(1);
  if (!contact) throw new Error("contact_not_found");

  const sources = await listAllSources();
  const sourcesRun: string[] = [];
  const sourcesSkipped: { source: string; reason: string }[] = [];
  const confidenceBefore = contact.confidenceScore ?? 0;
  let confidence = confidenceBefore;
  let totalCostMicros = 0;
  let finalEmailStatus: Contact["emailStatus"] =
    contact.emailStatus ?? "unverified";
  // Track ZeroBounce outcome so Bouncer only fires as a fallback when
  // ZeroBounce errored (or wasn't run at all). When ZeroBounce returns a
  // real verdict we trust it and skip Bouncer to avoid double-billing.
  let zerobounceErrored = false;
  let zerobounceRanCleanly = false;
  let bouncerRanCleanly = false;

  // Sort sources so ZeroBounce always runs before Bouncer in a single pass,
  // regardless of the order returned by listAllSources().
  const ordered = [...sources].sort((a, b) => {
    const rank = (k: string) =>
      k === "zerobounce" ? 0 : k === "bouncer" ? 1 : 2;
    return rank(a.source) - rank(b.source);
  });

  for (const s of ordered) {
    if (!isSourceActive(s)) {
      const reason = !s.envEnabled
        ? "env_disabled"
        : !s.envKeyPresent
          ? "missing_key"
          : "not_approved";
      sourcesSkipped.push({ source: s.source, reason });
      continue;
    }

    // Hard-stop paid sources whose month-to-date spend has reached the
    // configured monthly cap. Free sources are never gated this way.
    // Checked before the Bouncer-fallback guard so an over-budget paid
    // source is reported as `budget_exceeded` rather than masked by
    // `zerobounce_succeeded`.
    if (!s.isFreeSource && isOverBudget(s)) {
      sourcesSkipped.push({ source: s.source, reason: "budget_exceeded" });
      logger.info(
        {
          source: s.source,
          contactId,
          monthSpendMicros: s.monthSpendMicros,
          monthBudgetMicros: s.monthBudgetMicros,
        },
        "paid source auto-paused: monthly budget exceeded",
      );
      continue;
    }

    // Bouncer is a fallback for ZeroBounce. If ZeroBounce already ran
    // cleanly (any non-error verdict) in this pass, skip Bouncer.
    if (s.source === "bouncer" && zerobounceRanCleanly) {
      sourcesSkipped.push({
        source: s.source,
        reason: "zerobounce_succeeded",
      });
      continue;
    }

    let run: AdapterRun;
    try {
      run = await runAdapter(s.source, contact, s.isFreeSource);
    } catch (err) {
      logger.error(
        { err, source: s.source, contactId },
        "adapter threw unexpectedly",
      );
      sourcesSkipped.push({ source: s.source, reason: "adapter_error" });
      continue;
    }

    if (run.attempts === 0) {
      sourcesSkipped.push({ source: s.source, reason: "skipped_no_input" });
      continue;
    }

    if (s.source === "zerobounce") {
      // Use the adapter's explicit error-envelope flag rather than inferring
      // from ok/delta — legitimate verdicts like `unknown` have ok=false
      // and delta=0 but should NOT trigger Bouncer fallback.
      if (run.isErrorEnvelope) {
        zerobounceErrored = true;
      } else {
        zerobounceRanCleanly = true;
      }
    }
    if (s.source === "bouncer" && !run.isErrorEnvelope) {
      bouncerRanCleanly = true;
    }

    confidence = Math.max(0, Math.min(100, confidence + run.delta));
    sourcesRun.push(s.source);
    totalCostMicros += run.costMicros;
    if (run.newEmailStatus) finalEmailStatus = run.newEmailStatus;

    if (!opts.dryRun) {
      await db.insert(contactValidationLog).values({
        contactId,
        checkType: s.source,
        result: run.ok ? "ok" : "fail",
        confidenceDelta: run.delta,
        rawResponse: run.raw as object,
        costMicros: run.costMicros,
        attempts: run.attempts,
      });
      await recordSpend(s.source, run.costMicros);
    }
  }

  // If no real validator produced a verdict, fall back to threshold-based
  // status. ZeroBounce counts only when it didn't error; Bouncer counts when
  // it ran (it only runs as a fallback in the first place).
  const hadRealVerdict = zerobounceRanCleanly || bouncerRanCleanly;
  if (
    !hadRealVerdict &&
    finalEmailStatus !== "bounced" &&
    finalEmailStatus !== "do_not_contact"
  ) {
    finalEmailStatus = confidence >= 80 ? "verified" : "unverified";
  }

  if (!opts.dryRun) {
    await db
      .update(facilityContacts)
      .set({
        confidenceScore: confidence,
        emailStatus: finalEmailStatus,
        emailConfidence: confidence,
        lastEnrichedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(facilityContacts.id, contactId));
  }

  return {
    contactId,
    sourcesRun,
    sourcesSkipped,
    confidenceBefore,
    confidenceAfter: confidence,
    finalEmailStatus,
    totalCostMicros,
  };
}
