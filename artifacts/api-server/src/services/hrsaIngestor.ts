/**
 * HRSA Health Center Data Ingestor
 *
 * Queries USASpending.gov for HRSA (Health Resources & Services Administration)
 * grants to health centers, FQHCs, and rural clinics > $100k in the past 24
 * months and emits `grant_awarded` signals.
 *
 * We use the proven USASpending API (same pattern as usdaIngestor.ts) filtered
 * to the HHS awarding agency and HRSA-specific CFDAs / keywords, which gives a
 * stable JSON response. This avoids the HRSA data-warehouse export endpoints
 * that serve binary Excel files.
 *
 * Source: https://api.usaspending.gov/
 * No API key required.
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
const MIN_AWARD_AMOUNT = 100_000;
const DELAY_MS = 250;
const MONTHS_BACK = 24;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HrsaIngestResult {
  signalsInserted: number;
  errors: number;
}

interface SpendingAward {
  Award_ID?: string;
  Recipient_Name?: string;
  Award_Amount?: number;
  Start_Date?: string;
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
  const name = award.Recipient_Name?.trim();
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

  const npiKey = `HRSA-${(award.Award_ID ?? name).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`.slice(0, 10);

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
  opts: { limit?: number } = {},
): Promise<HrsaIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: HrsaIngestResult = { signalsInserted: 0, errors: 0 };

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
        "health center",
        "community health",
        "rural health",
        "federally qualified",
        "primary care",
        "clinic equipment",
        "imaging",
      ],
      time_period: [
        {
          start_date: cutoffDate(),
          end_date: new Date().toISOString().slice(0, 10),
        },
      ],
      award_amounts: [{ lower_bound: MIN_AWARD_AMOUNT }],
    },
    fields: [
      "Award_ID",
      "Recipient_Name",
      "Award_Amount",
      "Start_Date",
      "Description",
      "recipient_location_state_code",
      "recipient_location_city_name",
      "recipient_location_zip5",
    ],
    page: 1,
    limit,
    sort: "Award_Amount",
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
      logger.warn({ status: res.status }, "USASpending HRSA API error");
      result.errors += 1;
      return result;
    }

    const data = (await res.json()) as SpendingResponse;
    const awards = data.results ?? [];

    for (const award of awards) {
      const amount = award.Award_Amount ?? 0;
      if (amount < MIN_AWARD_AMOUNT) continue;

      try {
        const facilityId = await matchOrCreateFacility(award);
        if (!facilityId) {
          await sleep(DELAY_MS);
          continue;
        }

        const signalValue = `hrsa:${award.Award_ID ?? award.Recipient_Name}`;
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
          const confidence = Math.min(90, Math.round(60 + (amount / 1_000_000) * 5));
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
        logger.warn({ err, awardId: award.Award_ID }, "HRSA award processing error");
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
