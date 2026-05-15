/**
 * USDA Rural Development Awards Ingestor
 *
 * Queries the USASpending API for USDA Community Facilities rural health
 * awards > $100k in the past 24 months and emits `grant_awarded` signals.
 *
 * Source: https://api.usaspending.gov/
 * No API key required.
 *
 * NOTE: USASpending API renamed fields to Title Case in 2024.
 * Use "Award ID", "Recipient Name", "Award Amount", "Start Date" (with spaces).
 */
import { and, eq, ilike, or } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const USA_SPENDING_URL =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const MIN_AWARD_AMOUNT = 100_000;
const DELAY_MS = 200;
const MONTHS_BACK = 24;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface UsdaIngestResult {
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
  awarding_agency_name?: string;
}

interface SpendingResponse {
  results?: SpendingAward[];
  page_metadata?: { next?: string; hasNext?: boolean };
}

function cutoffDate(): string {
  const d = new Date(Date.now() - MONTHS_BACK * 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function matchFacility(recipientName: string | undefined): Promise<string | null> {
  if (!recipientName) return null;
  const name = recipientName.trim().slice(0, 60);
  const [match] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      or(
        ilike(facilities.name, `%${name}%`),
        ilike(facilities.doingBusinessAs, `%${name}%`),
        ilike(facilities.systemName, `%${name}%`),
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

export async function ingestUsda(
  opts: { limit?: number; states?: string[] } = {},
): Promise<UsdaIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: UsdaIngestResult = { signalsInserted: 0, errors: 0 };

  const stateFilter = opts.states?.length
    ? { recipient_location_state_codes: opts.states }
    : {};

  const body = {
    filters: {
      agencies: [
        {
          type: "awarding",
          tier: "toptier",
          name: "Department of Agriculture",
        },
      ],
      award_type_codes: ["A", "B", "C", "D"],
      keywords: ["community facility", "health", "hospital", "rural health", "clinic"],
      time_period: [{ start_date: cutoffDate(), end_date: new Date().toISOString().slice(0, 10) }],
      award_amounts: [{ lower_bound: MIN_AWARD_AMOUNT }],
      ...stateFilter,
    },
    fields: ["Award ID", "Recipient Name", "Award Amount", "Start Date", "Description"],
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
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: errBody.slice(0, 200) }, "USASpending USDA API error");
      result.errors += 1;
      return result;
    }

    const data = (await res.json()) as SpendingResponse;
    const awards = data.results ?? [];

    for (const award of awards) {
      const amount = award["Award Amount"] ?? 0;
      if (amount < MIN_AWARD_AMOUNT) continue;

      try {
        const facilityId = await matchFacility(award["Recipient Name"]);
        if (!facilityId) {
          await sleep(DELAY_MS);
          continue;
        }

        const awardId = award["Award ID"];
        const recipientName = award["Recipient Name"];
        const signalValue = `usda:${awardId ?? recipientName}`;
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
            source: "usda",
            isActive: true,
          });
          result.signalsInserted += 1;
        }
      } catch (err) {
        logger.warn({ err, awardId: award["Award ID"] }, "USDA award processing error");
        result.errors += 1;
      }

      await sleep(DELAY_MS);
    }
  } catch (err) {
    logger.error({ err }, "USDA ingest fetch error");
    result.errors += 1;
  }

  logger.info(result, "usda ingest complete");
  return result;
}
