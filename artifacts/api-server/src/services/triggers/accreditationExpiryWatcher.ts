/**
 * Accreditation expiry watcher (v2.0 Phase D, behavioural slice).
 *
 * Walks the existing `facility_accreditation` table and emits
 * `accreditation_renewal` purchase signals when a body's renewal target
 * is within the next 12 months. Idempotent — uses `signal_value` keyed on
 * the facility + body so re-runs don't duplicate rows.
 *
 * Why each body:
 *   - ACR (imaging) — 3-year cycle; renewal often triggers upgrade.
 *   - The Joint Commission (general hospitals) — survey cycle.
 *   - MQSA (mammography under FDA) — mandatory federal cert.
 *
 * Bodies not covered today (AAAHC ASC, AAAASF small ASCs, IAC, AAHA vet)
 * will land once the existing facility_accreditation row gets those date
 * columns — the watcher already iterates a per-body list and will pick
 * them up automatically.
 */
import { and, isNotNull, lte, gte, eq, inArray } from "drizzle-orm";
import {
  db,
  facilityAccreditation,
  purchaseSignals,
  type InsertSignal,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import { ClaimRegistry } from "../confidence/claimRegistry";

const SIGNAL_TYPE = "accreditation_renewal";
const WINDOW_MONTHS = 12;

interface BodyConfig {
  body: string;
  field: keyof typeof facilityAccreditation.$inferSelect;
  sourceType: string;
}

const BODIES: BodyConfig[] = [
  { body: "ACR",  field: "acrRenewalEst", sourceType: "acr_accreditation" },
  { body: "JC",   field: "jcNextSurveyEst", sourceType: "manual_curator" },
  { body: "MQSA", field: "mqsaCertDate",  sourceType: "fda_maude" },
];

export interface WatcherResult {
  scanned: number;
  signalsInserted: number;
  claimsRecorded: number;
  errors: number;
}

export async function watchAccreditationExpiries(): Promise<WatcherResult> {
  const start = Date.now();
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() + WINDOW_MONTHS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);

  let scanned = 0;
  let signalsInserted = 0;
  let claimsRecorded = 0;
  let errors = 0;
  const registry = new ClaimRegistry();

  const inserts: Array<InsertSignal & { signalValue: string }> = [];

  for (const cfg of BODIES) {
    try {
      const rows = await db
        .select({
          facilityId: facilityAccreditation.facilityId,
          target: facilityAccreditation[cfg.field],
        })
        .from(facilityAccreditation)
        .where(
          and(
            isNotNull(facilityAccreditation[cfg.field]),
            gte(facilityAccreditation[cfg.field], todayStr),
            lte(facilityAccreditation[cfg.field], cutoffStr),
          ),
        );
      scanned += rows.length;

      for (const r of rows) {
        if (!r.target) continue;
        const target = String(r.target);

        inserts.push({
          facilityId: r.facilityId,
          signalType: SIGNAL_TYPE,
          signalValue: `accred:${cfg.body}:${target}`,
          confidence: 85,
          source: cfg.sourceType,
          metadata: {
            body: cfg.body,
            renewalTarget: target,
            windowMonths: WINDOW_MONTHS,
          },
        });

        try {
          await registry.record({
            entityTable: "facilities",
            entityId: r.facilityId,
            claimField: `accreditation_renewal_${cfg.body.toLowerCase()}`,
            claimValue: target,
            sourceType: cfg.sourceType,
          });
          claimsRecorded++;
        } catch (err) {
          errors++;
          logger.error({ err, body: cfg.body, facilityId: r.facilityId }, "claim record failed");
        }
      }
    } catch (err) {
      errors++;
      logger.error({ err, body: cfg.body }, "accreditation expiry sweep failed for body");
    }
  }

  // Idempotency: skip (facility, signal_value) tuples already active.
  if (inserts.length > 0) {
    const existing = await db
      .select({
        facilityId: purchaseSignals.facilityId,
        signalValue: purchaseSignals.signalValue,
      })
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.signalType, SIGNAL_TYPE),
          eq(purchaseSignals.isActive, true),
          inArray(
            purchaseSignals.facilityId,
            Array.from(new Set(inserts.map((i) => i.facilityId))),
          ),
        ),
      );
    const seen = new Set(existing.map((e) => `${e.facilityId}|${e.signalValue ?? ""}`));
    const fresh = inserts.filter((i) => !seen.has(`${i.facilityId}|${i.signalValue}`));
    if (fresh.length > 0) {
      await db.insert(purchaseSignals).values(fresh);
      signalsInserted = fresh.length;
    }
  }

  logger.info(
    { scanned, signalsInserted, claimsRecorded, errors, ms: Date.now() - start },
    "accreditation expiry watcher complete",
  );

  return { scanned, signalsInserted, claimsRecorded, errors };
}
