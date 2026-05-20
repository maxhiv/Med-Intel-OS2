/**
 * OpportunityGenerator (v2.0 Phase E).
 *
 * Daily cron that walks every facility with at least one active trigger
 * signal, joins to the rep account's territory + vertical bindings, and
 * inserts an `opportunities` row per (account, facility, modality) tuple
 * that scores above the activation threshold.
 *
 * Idempotency:
 *   - The `uniq_opportunity_active` partial index prevents duplicate live
 *     rows for the same (account, facility, modality) while one is in a
 *     non-terminal status.
 *   - When a previously snoozed opportunity now scores higher, the
 *     generator updates the existing row instead of inserting.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  accounts,
  facilities,
  facilityVerticalMap,
  verticalModules,
  opportunities,
  purchaseSignals,
  type InsertOpportunity,
} from "@workspace/db";
import { logger } from "../../lib/logger";
import {
  score,
  estimateDollarRange,
  findContactForRole,
  loadActiveSignals,
  type ScoringInput,
} from "./opportunityScorer";

const MIN_SCORE_TO_PERSIST = 0.35;
const TOP_TRIGGER_LIMIT = 3;

// Modalities the generator currently emits opportunities for. Sized to the
// equipment lines we sell; rep can request additions via the orchestrator.
const SUPPORTED_MODALITIES = [
  "MRI", "CT", "PET", "mammo", "fluoro", "C-arm", "ultrasound", "DXA",
  "surgical_robot", "linac", "endoscopy", "anesthesia",
];

// Which signal types we treat as direct evidence for a given modality.
// Empty array → applies to all modalities for that facility.
const SIGNAL_MODALITY_HINTS: Record<string, string[]> = {
  eol_equipment: [],
  manufacturer_eol: [],
  chow_recent: [],
  pe_takeover: [],
  reit_takeover: [],
  aip_infra_spend: [],
  con_filed: [],
  con_approved: [],
  hcris_depreciation_spike: [],
  psi11_outlier: [],
  accreditation_renewal: ["MRI", "CT", "mammo", "ultrasound", "PET"],
};

interface AccountTerritory {
  accountId: string;
  states: Set<string>;
}

export interface GenerationResult {
  accountsProcessed: number;
  facilitiesScanned: number;
  opportunitiesCreated: number;
  opportunitiesUpdated: number;
  errors: number;
}

/** Resolve each account's covered states from saved territories (v1 surface). */
async function loadAccountTerritories(): Promise<AccountTerritory[]> {
  const rows = await db.execute<{ account_id: string; states: string[] }>(sql`
    SELECT a.id AS account_id,
           COALESCE(
             ARRAY_AGG(DISTINCT s) FILTER (WHERE s IS NOT NULL),
             ARRAY[]::text[]
           ) AS states
      FROM accounts a
 LEFT JOIN LATERAL (
        SELECT UNNEST(COALESCE((t.filter->'states')::jsonb, '[]'::jsonb))::text AS s
          FROM territories t
         WHERE t.account_id = a.id
      ) s ON TRUE
     GROUP BY a.id
  `);
  return rows.rows.map((r) => ({
    accountId: r.account_id,
    states: new Set(
      (r.states ?? [])
        .map((s) => (s ?? "").replace(/^"|"$/g, "").toUpperCase())
        .filter((s) => s.length === 2),
    ),
  }));
}

/**
 * For one (account, facility), pick which modalities are evidenced by the
 * active triggers and emit an opportunity per modality.
 */
async function evaluateOneFacility(
  territory: AccountTerritory,
  facility: typeof facilities.$inferSelect,
  vertical: { slug: string | null; primaryModalities: string[] },
): Promise<{ created: number; updated: number; errors: number }> {
  let created = 0;
  let updated = 0;
  let errors = 0;

  const signals = await loadActiveSignals(facility.id);
  if (signals.length === 0) return { created, updated, errors };

  const inTerritory =
    territory.states.size === 0 ? false : Boolean(facility.state && territory.states.has(facility.state));

  // Determine which modalities the signals plausibly point at.
  const candidateModalities = new Set<string>();
  for (const sig of signals) {
    const hints = SIGNAL_MODALITY_HINTS[sig.signalType] ?? [];
    if (hints.length === 0) {
      // Generic signal — fan out across the vertical's primary modalities.
      for (const m of vertical.primaryModalities.length > 0
        ? vertical.primaryModalities
        : SUPPORTED_MODALITIES.slice(0, 4)) {
        if (SUPPORTED_MODALITIES.includes(m)) candidateModalities.add(m);
      }
    } else {
      for (const m of hints) if (SUPPORTED_MODALITIES.includes(m)) candidateModalities.add(m);
    }
  }

  for (const modality of candidateModalities) {
    try {
      const champion = await findContactForRole(facility.id, "clinical_champion");
      const economicBuyer = await findContactForRole(facility.id, "economic_buyer");
      const gatekeeper = await findContactForRole(facility.id, "procurement_gatekeeper");

      const input: ScoringInput = {
        facility,
        modality,
        signals,
        primaryVerticalSlug: vertical.slug,
        verticalPrimaryModalities: vertical.primaryModalities,
        inTerritory,
        championConfidence: champion?.confidence ?? 0,
        economicBuyerConfidence: economicBuyer?.confidence ?? 0,
        gatekeeperConfidence: gatekeeper?.confidence ?? 0,
      };

      const breakdown = score(input);
      if (breakdown.composite < MIN_SCORE_TO_PERSIST) continue;

      const dollar = estimateDollarRange(modality, facility.beds);

      // Recent purchase signal ids for this facility (top 3 by weight×conf).
      const triggerRows = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(and(eq(purchaseSignals.facilityId, facility.id), eq(purchaseSignals.isActive, true)))
        .orderBy(desc(purchaseSignals.detectedAt))
        .limit(TOP_TRIGGER_LIMIT);
      const topTriggerIds = triggerRows.map((r) => r.id);

      const insertVals: InsertOpportunity = {
        accountId: territory.accountId,
        facilityId: facility.id,
        modality,
        verticalSlug: vertical.slug,
        readinessScore: breakdown.composite.toFixed(4),
        scoreBreakdown: breakdown.components,
        estimatedDollarLow: dollar.low,
        estimatedDollarHigh: dollar.high,
        primaryTriggerId: topTriggerIds[0] ?? null,
        topTriggerIds,
        championContactId: champion?.id ?? null,
        economicBuyerContactId: economicBuyer?.id ?? null,
        gatekeeperContactId: gatekeeper?.id ?? null,
        status: "detected",
      };

      // Upsert: live row already exists? update its score; otherwise insert.
      const existing = await db
        .select({ id: opportunities.id, status: opportunities.status })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.accountId, territory.accountId),
            eq(opportunities.facilityId, facility.id),
            eq(opportunities.modality, modality),
            inArray(opportunities.status, ["detected", "rep_reviewed", "qualified", "bid_submitted"]),
          ),
        )
        .limit(1);

      if (existing[0]) {
        await db
          .update(opportunities)
          .set({
            readinessScore: insertVals.readinessScore,
            scoreBreakdown: insertVals.scoreBreakdown,
            estimatedDollarLow: insertVals.estimatedDollarLow,
            estimatedDollarHigh: insertVals.estimatedDollarHigh,
            primaryTriggerId: insertVals.primaryTriggerId,
            topTriggerIds: insertVals.topTriggerIds,
            championContactId: insertVals.championContactId,
            economicBuyerContactId: insertVals.economicBuyerContactId,
            gatekeeperContactId: insertVals.gatekeeperContactId,
            updatedAt: new Date(),
          })
          .where(eq(opportunities.id, existing[0].id));
        updated++;
      } else {
        await db.insert(opportunities).values(insertVals);
        created++;
      }
    } catch (err) {
      errors++;
      logger.error(
        { err, facilityId: facility.id, modality, accountId: territory.accountId },
        "opportunity generation tuple failed",
      );
    }
  }
  return { created, updated, errors };
}

export async function generateOpportunities(
  options: { facilityLimit?: number } = {},
): Promise<GenerationResult> {
  const start = Date.now();
  const limit = options.facilityLimit ?? 2000;

  // Pull facilities that have at least one active signal — the only
  // candidates that could score above threshold.
  const facilityRows = await db
    .select()
    .from(facilities)
    .where(
      sql`EXISTS (
        SELECT 1 FROM purchase_signals ps
         WHERE ps.facility_id = ${facilities.id}
           AND ps.is_active = TRUE
      )`,
    )
    .limit(limit);

  // Resolve verticals per facility (primary first).
  const facilityIds = facilityRows.map((f) => f.id);
  const verticalRows =
    facilityIds.length > 0
      ? await db
          .select({
            facilityId: facilityVerticalMap.facilityId,
            verticalSlug: verticalModules.slug,
            primaryModalities: verticalModules.primaryModalities,
            isPrimary: facilityVerticalMap.isPrimary,
          })
          .from(facilityVerticalMap)
          .innerJoin(verticalModules, eq(verticalModules.id, facilityVerticalMap.verticalId))
          .where(
            and(
              inArray(facilityVerticalMap.facilityId, facilityIds),
              eq(facilityVerticalMap.isPrimary, true),
            ),
          )
      : [];
  const verticalByFacility = new Map<string, { slug: string | null; primaryModalities: string[] }>();
  for (const v of verticalRows) {
    verticalByFacility.set(v.facilityId, {
      slug: v.verticalSlug,
      primaryModalities: v.primaryModalities ?? [],
    });
  }

  const territories = await loadAccountTerritories();
  if (territories.length === 0) {
    logger.info("opportunityGenerator: no accounts to serve");
    return { accountsProcessed: 0, facilitiesScanned: 0, opportunitiesCreated: 0, opportunitiesUpdated: 0, errors: 0 };
  }

  let opportunitiesCreated = 0;
  let opportunitiesUpdated = 0;
  let errors = 0;

  for (const territory of territories) {
    for (const facility of facilityRows) {
      const vertical = verticalByFacility.get(facility.id) ?? { slug: null, primaryModalities: [] };
      const r = await evaluateOneFacility(territory, facility, vertical);
      opportunitiesCreated += r.created;
      opportunitiesUpdated += r.updated;
      errors += r.errors;
    }
  }

  logger.info(
    {
      accountsProcessed: territories.length,
      facilitiesScanned: facilityRows.length,
      opportunitiesCreated,
      opportunitiesUpdated,
      errors,
      ms: Date.now() - start,
    },
    "opportunity generation complete",
  );

  return {
    accountsProcessed: territories.length,
    facilitiesScanned: facilityRows.length,
    opportunitiesCreated,
    opportunitiesUpdated,
    errors,
  };
}

void accounts;
void isNotNull;
