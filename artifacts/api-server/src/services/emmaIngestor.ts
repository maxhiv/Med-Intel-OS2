/**
 * EMMA Municipal Bond Ingestor
 *
 * Monitors MSRB EMMA for healthcare/hospital municipal bond issuances > $5M
 * and emits `bond_issued` purchase signals. Also inserts into financial_documents.
 *
 * Docs: https://emma.msrb.org/
 */
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals, financialDocuments } from "@workspace/db";
import { logger } from "../lib/logger";

const EMMA_SEARCH = "https://emma.msrb.org/api/SecSearch.aspx";
const EMMA_ISSUER = "https://emma.msrb.org/api/IssuerSearch.aspx";
const TARGET_STATES = ["IL", "MI", "NY", "VA", "CT", "MD", "KY", "MS", "AL", "GA", "MA"];
const MIN_AMOUNT = 5_000_000;
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EmmaIngestResult {
  signalsInserted: number;
  errors: number;
}

interface EmmaResult {
  IssuerName?: string;
  IssuerId?: string;
  IssuerType?: string;
  PrincipalAmount?: number;
  MaturityDate?: string;
  IssuanceDate?: string;
  Cusip?: string;
  DetailUrl?: string;
}

async function matchFacilityByName(name: string): Promise<string | null> {
  if (!name) return null;
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

async function processBondResult(r: EmmaResult, result: EmmaIngestResult): Promise<void> {
  if (!r.Cusip) return;
  const amount = r.PrincipalAmount ?? 0;
  if (amount < MIN_AMOUNT) return;

  const issuerType = (r.IssuerType ?? "").toLowerCase();
  if (!issuerType.includes("hospital") && !issuerType.includes("health")) return;

  const signalValue = `emma:${r.Cusip}`;
  const [exists] = await db
    .select({ id: purchaseSignals.id })
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.signalType, "bond_issued"),
        eq(purchaseSignals.signalValue, signalValue),
      ),
    )
    .limit(1);
  if (exists) return;

  const facilityId = await matchFacilityByName(r.IssuerName ?? "");
  if (!facilityId) return;

  const issuanceYear = r.IssuanceDate
    ? new Date(r.IssuanceDate).getFullYear()
    : new Date().getFullYear();

  await db
    .insert(financialDocuments)
    .values({
      facilityId,
      docType: "municipal_bond",
      fiscalYear: issuanceYear,
      sourceUrl: r.DetailUrl ?? null,
      parsedJson: {
        cusip: r.Cusip,
        issuerName: r.IssuerName,
        principalAmount: amount,
        maturityDate: r.MaturityDate,
        issuanceDate: r.IssuanceDate,
        issuerType: r.IssuerType,
      },
    })
    .onConflictDoNothing();

  await db.insert(purchaseSignals).values({
    facilityId,
    signalType: "bond_issued",
    signalValue,
    confidence: 85,
    source: "emma",
    isActive: true,
  });
  result.signalsInserted += 1;
}

export async function ingestEmma(
  opts: { limit?: number } = {},
): Promise<EmmaIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const result: EmmaIngestResult = { signalsInserted: 0, errors: 0 };

  const keywords = ["hospital imaging equipment", "hospital", "health system imaging"];

  for (const kw of keywords) {
    const params = new URLSearchParams({
      type: "O",
      category: "bond",
      keywords: kw,
      pageSize: String(limit),
    });

    try {
      const res = await fetch(`${EMMA_SEARCH}?${params}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!res.ok) {
        logger.warn({ status: res.status, kw }, "EMMA search API error");
        result.errors += 1;
        continue;
      }
      const body = (await res.json()) as { Results?: EmmaResult[] };
      const items = body.Results ?? [];

      for (const item of items) {
        try {
          await processBondResult(item, result);
        } catch (err) {
          logger.warn({ err, cusip: item.Cusip }, "EMMA bond processing error");
          result.errors += 1;
        }
        await sleep(DELAY_MS);
      }
    } catch (err) {
      logger.warn({ err, kw }, "EMMA search fetch error");
      result.errors += 1;
    }

    await sleep(DELAY_MS);
  }

  for (const state of TARGET_STATES.slice(0, 5)) {
    const params = new URLSearchParams({
      state,
      type: "H",
      pageSize: "10",
    });
    try {
      const res = await fetch(`${EMMA_ISSUER}?${params}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { Results?: EmmaResult[] };
      const items = body.Results ?? [];
      for (const item of items) {
        try {
          await processBondResult(item, result);
        } catch (err) {
          result.errors += 1;
        }
        await sleep(DELAY_MS);
      }
    } catch {
    }
    await sleep(DELAY_MS);
  }

  logger.info(result, "emma ingest complete");
  return result;
}
