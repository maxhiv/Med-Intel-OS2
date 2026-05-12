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
    };
  });
}

function isSourceActive(s: SourceStatus): boolean {
  if (s.isFreeSource) return true;
  return s.envEnabled && s.envKeyPresent && s.approved;
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

  for (const s of sources) {
    if (!isSourceActive(s)) {
      const reason = !s.envEnabled
        ? "env_disabled"
        : !s.envKeyPresent
          ? "missing_key"
          : "not_approved";
      sourcesSkipped.push({ source: s.source, reason });
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

  // If no real validator ran, fall back to the threshold-based status.
  if (
    !sourcesRun.includes("zerobounce") &&
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
