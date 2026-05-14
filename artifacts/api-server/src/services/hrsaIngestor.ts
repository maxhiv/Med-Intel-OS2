/**
 * HRSA Health Center Data Ingestor
 *
 * Pulls Federally Qualified Health Center (FQHC) awardee data from HRSA.
 * Emits `grant_awarded` signals for FQHCs with capital awards in the past
 * 24 months. Creates facility records for unmatched FQHCs.
 *
 * Source: https://data.hrsa.gov/
 * No API key required.
 */
import { and, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  accountFacilities,
  accounts,
} from "@workspace/db";
import { logger } from "../lib/logger";

const HRSA_API =
  "https://data.hrsa.gov/api/export/excel/Health_Center_Program_Awardees_Data";
const TARGET_STATES = ["IL", "MI", "NY", "VA", "CT", "MD", "KY", "MS", "AL", "GA", "MA"];
const MIN_PATIENTS = 10_000;
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HrsaIngestResult {
  signalsInserted: number;
  errors: number;
}

interface HrsaRecord {
  grantee_name?: string;
  state_abbr?: string;
  city?: string;
  zip_code?: string;
  tot_patients?: number | string;
  total_budget?: number | string;
  grant_period_start?: string;
  grant_period_end?: string;
  bhcmis_id?: string;
  address?: string;
}

async function matchOrCreateFacility(
  rec: HrsaRecord,
): Promise<string | null> {
  const name = rec.grantee_name?.trim();
  const state = rec.state_abbr?.trim().toUpperCase();
  if (!name || !state) return null;

  const [existing] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      and(
        ilike(facilities.name, `%${name.slice(0, 40)}%`),
        eq(facilities.state, state),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(facilities)
    .values({
      npi: `HRSA-${rec.bhcmis_id ?? name.slice(0, 10).replace(/\s/g, "-")}`.slice(0, 10),
      name,
      facilityType: "Federally Qualified Health Center",
      fqhcDesignation: true,
      state,
      city: rec.city ?? null,
      zip: rec.zip_code ?? null,
      address1: rec.address ?? null,
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

function isCapitalAwardRecent(rec: HrsaRecord): boolean {
  const startDate = rec.grant_period_start;
  if (!startDate) return false;
  const then = new Date(startDate);
  const cutoff = new Date(Date.now() - 24 * 30 * 24 * 60 * 60 * 1000);
  return then >= cutoff;
}

export async function ingestHrsa(
  opts: { limit?: number } = {},
): Promise<HrsaIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const result: HrsaIngestResult = { signalsInserted: 0, errors: 0 };

  try {
    const res = await fetch(HRSA_API, {
      headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "HRSA API error");
      result.errors += 1;
      return result;
    }

    const body = (await res.json()) as { data?: HrsaRecord[] } | HrsaRecord[];
    const records: HrsaRecord[] = Array.isArray(body)
      ? body
      : (body as { data?: HrsaRecord[] }).data ?? [];

    let processed = 0;
    for (const rec of records) {
      if (processed >= limit) break;

      const state = rec.state_abbr?.trim().toUpperCase();
      if (!state || !TARGET_STATES.includes(state)) continue;

      const patients = Number(rec.tot_patients ?? 0);
      if (patients < MIN_PATIENTS) continue;

      processed++;

      try {
        const facilityId = await matchOrCreateFacility(rec);
        if (!facilityId) {
          await sleep(DELAY_MS);
          continue;
        }

        if (isCapitalAwardRecent(rec)) {
          const grantId = rec.bhcmis_id ?? `${rec.grantee_name}-${rec.grant_period_start}`;
          const signalValue = `hrsa:${grantId}`;
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
            await db.insert(purchaseSignals).values({
              facilityId,
              signalType: "grant_awarded",
              signalValue,
              confidence: 75,
              source: "hrsa",
              isActive: true,
            });
            result.signalsInserted += 1;
          }
        }
      } catch (err) {
        logger.warn({ err, name: rec.grantee_name }, "HRSA record error");
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
