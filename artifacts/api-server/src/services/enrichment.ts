/**
 * Contact enrichment waterfall (stubbed adapters).
 *
 * Two-gate model for paid sources: a paid source is "active" only when
 * (a) PAID_ENRICHMENT_<UPPER_SOURCE>_ENABLED env var is "true",
 * (b) the corresponding API key env var is present, AND
 * (c) the database `enrichment_source_approvals.approved` row is true.
 *
 * Free sources are always available; paid adapters return a "skipped"
 * result if any gate is missing.
 */
import { eq } from "drizzle-orm";
import {
  db,
  facilityContacts,
  contactValidationLog,
  enrichmentSourceApprovals,
  FREE_ENRICHMENT_SOURCES,
  PAID_ENRICHMENT_SOURCES,
  type Contact,
} from "@workspace/db";

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
    return {
      source,
      isFreeSource: isFree,
      envEnabled: envEnabledFor(source),
      envKeyPresent: envKeyPresentFor(source),
      approved: isFree ? true : Boolean(a?.approved),
      approvedAt: a?.approvedAt ?? null,
      approvedBy: a?.approvedBy ?? null,
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
    const delta = s.isFreeSource ? 4 : 10;
    confidence = Math.min(100, confidence + delta);
    sourcesRun.push(s.source);

    if (!opts.dryRun) {
      await db.insert(contactValidationLog).values({
        contactId,
        checkType: s.source,
        result: "ok",
        confidenceDelta: delta,
        rawResponse: { stub: true, source: s.source },
      });
    }
  }

  const newStatus =
    confidence >= 80 ? "verified" : "unverified";

  if (!opts.dryRun) {
    await db
      .update(facilityContacts)
      .set({
        confidenceScore: confidence,
        emailStatus: newStatus as Contact["emailStatus"],
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
    finalEmailStatus: newStatus,
  };
}
