/**
 * HRSA Health Center Data Ingestor
 *
 * Queries USASpending.gov for HRSA (Health Resources & Services Administration)
 * grants to health centers, FQHCs, and rural clinics in the past 24 months and
 * emits `grant_awarded` signals.
 *
 * We use the proven USASpending API (same pattern as usdaIngestor.ts) filtered
 * to the HRSA subtier awarding agency. Target states and minimum patient-volume
 * proxy (award amount ≥ $250k, correlating to ≥ 10k patient visits/year for
 * typical HRSA New Access Point awards) are enforced to match the HRSA dataset
 * spec.
 *
 * Source: https://api.usaspending.gov/
 * No API key required.
 *
 * NOTE: USASpending API renamed fields to Title Case in 2024.
 * Use "Award ID", "Recipient Name", "Award Amount", "Start Date" (with spaces).
 */
import { and, eq, ilike, or } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  accountFacilities,
  accounts,
} from "@workspace/db";
import { logger } from "../lib/logger";

const USA_SPENDING_URL =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";

// Proxy for ≥ 10,000 patient visits/year: HRSA New Access Point awards
// typically run $650k–$2M for sites serving that volume; $250k floor captures
// expansion awards to existing sites while excluding tiny demonstration grants.
const MIN_AWARD_AMOUNT = 250_000;

// CMX target markets (mirrors conFilingsIngestor + medicareUtilIngestor)
const TARGET_STATES = new Set([
  "IL", "MI", "NY", "VA", "CT", "MD", "KY", "MS", "AL", "GA", "MA",
  "OH", "IN", "WI", "MN", "MO", "TN", "NC", "FL", "TX", "CA",
]);

const DELAY_MS = 200;
const MONTHS_BACK = 24;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HrsaIngestResult {
  signalsInserted: number;
  errors: number;
}

// USASpending renamed fields to "Title Case" in 2024 — use bracket notation
interface SpendingAward {
  "Award ID"?: string;
  "Recipient Name"?: string;
  "Award Amount"?: number;
  "Start Date"?: string;
  Description?: string;
  recipient_location_state_code?: string;
  recipient_location_city_name?: string;
  recipient_location_zip5?: string;
}

interface SpendingResponse {
  results?: SpendingAward[];
  page_metadata?: { next?: string; hasNext?: boolean };
}

function cutoffDate(): string {
  const d = new Date(Date.now() - MONTHS_BACK * 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function matchOrCreateFacility(award: SpendingAward): Promise<string | null> {
  const name = award["Recipient Name"]?.trim();
  if (!name) return null;

  const [existing] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      or(
        ilike(facilities.name, `%${name.slice(0, 50)}%`),
        ilike(facilities.doingBusinessAs, `%${name.slice(0, 50)}%`),
        ilike(facilities.systemName, `%${name.slice(0, 50)}%`),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const state = (award.recipient_location_state_code ?? "").trim().toUpperCase();
  if (!state || state.length !== 2) return null;

  const awardId = award["Award ID"] ?? name;
  const npiKey = `HRSA-${awardId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`.slice(0, 10);

  const [created] = await db
    .insert(facilities)
    .values({
      npi: npiKey,
      name: name.slice(0, 200),
      facilityType: "Federally Qualified Health Center",
      fqhcDesignation: true,
      state,
      city: award.recipient_location_city_name ?? null,
      zip: award.recipient_location_zip5 ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: facilities.id });

  if (created) {
    const allAccounts = await db.select({ id: accounts.id }).from(accounts);
    for (const acct of allAccounts) {
      await db
        .insert(accountFacilities)
        .values({ accountId: acct.id, facilityId: created.id })
        .onConflictDoNothing();
    }
    return created.id;
  }
  return null;
}

export async function ingestHrsa(
  opts: { limit?: number; states?: string[] } = {},
): Promise<HrsaIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: HrsaIngestResult = { signalsInserted: 0, errors: 0 };

  const stateCodes = opts.states?.length ? opts.states : Array.from(TARGET_STATES);

  const requestBody = {
    filters: {
      agencies: [
        {
          type: "awarding",
          tier: "subtier",
          name: "Health Resources and Services Administration",
        },
      ],
      award_type_codes: ["A", "B", "C", "D"],
      keywords: [
        "community health center",
        "federally qualified health center",
        "rural health clinic",
        "new access point",
        "health center program",
      ],
      recipient_location_state_codes: stateCodes,
      time_period: [
        {
          start_date: cutoffDate(),
          end_date: new Date().toISOString().slice(0, 10),
        },
      ],
      award_amounts: [{ lower_bound: MIN_AWARD_AMOUNT }],
    },
    fields: [
      "Award ID",
      "Recipient Name",
      "Award Amount",
      "Start Date",
      "Description",
      "recipient_location_state_code",
      "recipient_location_city_name",
      "recipient_location_zip5",
    ],
    page: 1,
    limit,
    sort: "Award Amount",
    order: "desc",
  };

  try {
    const res = await fetch(USA_SPENDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MedIntel/1.0",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: errBody.slice(0, 200) }, "USASpending HRSA API error");
      result.errors += 1;
      return result;
    }

    const data = (await res.json()) as SpendingResponse;
    const awards = data.results ?? [];

    for (const award of awards) {
      const amount = award["Award Amount"] ?? 0;
      if (amount < MIN_AWARD_AMOUNT) continue;

      const state = (award.recipient_location_state_code ?? "").trim().toUpperCase();
      if (state && !TARGET_STATES.has(state)) continue;

      try {
        const facilityId = await matchOrCreateFacility(award);
        if (!facilityId) {
          await sleep(DELAY_MS);
          continue;
        }

        const awardId = award["Award ID"];
        const recipientName = award["Recipient Name"];
        const signalValue = `hrsa:${awardId ?? recipientName}`;
        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, facilityId),
              eq(purchaseSignals.signalType, "grant_awarded"),
              eq(purchaseSignals.signalValue, signalValue),
            ),
          )
          .limit(1);

        if (!exists) {
          const confidence = Math.min(90, Math.round(65 + (amount / 2_000_000) * 25));
          await db.insert(purchaseSignals).values({
            facilityId,
            signalType: "grant_awarded",
            signalValue,
            confidence,
            source: "hrsa",
            isActive: true,
          });
          result.signalsInserted += 1;
        }
      } catch (err) {
        logger.warn({ err, awardId: award["Award ID"] }, "HRSA award processing error");
        result.errors += 1;
      }

      await sleep(DELAY_MS);
    }
  } catch (err) {
    logger.error({ err }, "HRSA ingest fetch error");
    result.errors += 1;
  }

  logger.info(result, "hrsa ingest complete");
  return result;
}
