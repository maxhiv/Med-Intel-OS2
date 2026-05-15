/**
 * IRS SOI 990 Masterfile Extract Ingestor
 *
 * Downloads the IRS Statistics of Income 990 Masterfile Extract (~100MB, 345k rows)
 * and emits purchase signals for matched facilities. Matching uses the ein_crosswalk
 * table built by einCrosswalkBuilder.ts.
 *
 * Fields used:
 *   EIN            → crosswalk lookup
 *   operatehosptlcd → filter: 'Y' = hospital
 *   nonpfrea       → '3' = hospital, '5' = medical research
 *   tax_pd         → tax period YYYYMM
 *   totcntrbgfts   → total contributions → grant_awarded if > $1M
 *   txexmptbndsend → bond liabilities EOY → bond_issuance if > 0
 *   lndbldgsequipend → net equipment value
 *   deprcatndepletn  → depreciation → equipment_aging ratio signal
 *   infotech       → IT spend → it_investment if > $50k
 *   totassetsend   → total assets (confidence scaling)
 *
 * Source: https://www.irs.gov/pub/irs-soi/24eofinextract990.dat
 * No API key required.
 */
import { createInterface } from "readline";
import { sql, eq, and } from "drizzle-orm";
import { db, facilities, purchaseSignals, einCrosswalk } from "@workspace/db";
import { logger } from "../lib/logger";

const EOI_URL = "https://www.irs.gov/pub/irs-soi/24eofinextract990.dat";
const FETCH_TIMEOUT_MS = 120_000;
const MIN_GRANT_AMOUNT = 1_000_000;
const MIN_IT_SPEND = 50_000;
const EQUIP_AGING_RATIO = 0.12;

export interface IrsEoiResult {
  rowsProcessed: number;
  facilitiesMatched: number;
  signalsInserted: number;
  errors: number;
}

function fetchWithTimeout(url: string): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: ac.signal,
    headers: {
      "User-Agent": `MedIntelOS ${process.env.PLATFORM_ADMIN_EMAIL ?? "research@medintel.ai"}`,
    },
  }).finally(() => clearTimeout(t));
}

async function getFacilityIdsForEin(ein: string, targetStates: string[]): Promise<string[]> {
  // First try the crosswalk table
  const xwalk = await db
    .select({ facilityId: einCrosswalk.facilityId })
    .from(einCrosswalk)
    .where(eq(einCrosswalk.ein, ein))
    .limit(50);

  let ids = xwalk.map((r) => r.facilityId).filter((id): id is string => id !== null);

  // Also try direct EIN match on facilities table
  if (ids.length === 0) {
    const direct = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.ein, ein))
      .limit(50);
    ids = direct.map((r) => r.id);
  }

  // State filter — only apply if we have ids and a state filter
  if (targetStates.length > 0 && ids.length > 0) {
    const filtered = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(
        sql`id = ANY(ARRAY[${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]) AND state = ANY(ARRAY[${sql.join(
          targetStates.map((s) => sql`${s}`),
          sql`, `,
        )}])`,
      );
    return filtered.map((r) => r.id);
  }

  return ids;
}

async function upsertSignal(
  facilityId: string,
  signalType: string,
  signalValue: string,
  confidence: number,
  source: string,
  sourceUrl: string | null,
): Promise<boolean> {
  const [exists] = await db
    .select({ id: purchaseSignals.id })
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.facilityId, facilityId),
        eq(purchaseSignals.signalType, signalType as any),
        eq(purchaseSignals.signalValue, signalValue),
      ),
    )
    .limit(1);
  if (exists) return false;

  await db.insert(purchaseSignals).values({
    facilityId,
    signalType: signalType as any,
    signalValue,
    confidence,
    source,
    sourceUrl,
    isActive: true,
  });
  return true;
}

export async function ingestIrsEoi(
  opts: { limit?: number; states?: string[]; taxPeriod?: string } = {},
): Promise<IrsEoiResult> {
  const limit = opts.limit ?? Infinity;
  const targetStates = opts.states?.map((s) => s.toUpperCase()) ?? [];
  const result: IrsEoiResult = {
    rowsProcessed: 0,
    facilitiesMatched: 0,
    signalsInserted: 0,
    errors: 0,
  };

  logger.info({ opts }, "irs_eoi ingest starting");

  const res = await fetchWithTimeout(EOI_URL);
  if (!res.ok || !res.body) {
    logger.error({ status: res.status }, "irs_eoi fetch failed");
    result.errors++;
    return result;
  }

  // Stream-parse the tab-delimited file line by line
  const rl = createInterface({ input: res.body as NodeJS.ReadableStream, crlfDelay: Infinity });
  let header: string[] | null = null;
  let fieldIndex: Record<string, number> = {};

  for await (const line of rl) {
    if (!header) {
      header = line.split("\t").map((h) => h.trim().toLowerCase());
      fieldIndex = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }

    if (result.rowsProcessed >= limit) break;

    const cols = line.split("\t");
    const get = (field: string): string => cols[fieldIndex[field] ?? -1]?.trim() ?? "";
    const getNum = (field: string): number => parseFloat(get(field)) || 0;

    const ein = get("ein").replace(/\D/g, "").padStart(9, "0");
    if (!ein || ein === "000000000") continue;

    // Filter to healthcare orgs
    const operatesHospital = get("operatehosptlcd").toUpperCase() === "Y";
    const nonpfrea = get("nonpfrea");
    const isHealthcare = operatesHospital || ["3", "5"].includes(nonpfrea);
    if (!isHealthcare) continue;

    const taxPd = get("tax_pd");
    if (opts.taxPeriod && taxPd !== opts.taxPeriod) continue;

    result.rowsProcessed++;

    try {
      const facilityIds = await getFacilityIdsForEin(ein, targetStates);
      if (facilityIds.length === 0) continue;
      result.facilitiesMatched += facilityIds.length;

      const totcntrbgfts = getNum("totcntrbgfts");
      const txexmptbndsend = getNum("txexmptbndsend");
      const lndbldgsequipend = getNum("lndbldgsequipend");
      const deprcatndepletn = getNum("deprcatndepletn");
      const infotech = getNum("infotech");
      const agingRatio = lndbldgsequipend > 0 ? deprcatndepletn / lndbldgsequipend : 0;
      const ppUrl = `https://projects.propublica.org/nonprofits/organizations/${ein}`;

      for (const facilityId of facilityIds) {
        // 1. Fiscal year end
        const inserted1 = await upsertSignal(
          facilityId,
          "fiscal_year_end",
          `irs990:${ein}:${taxPd}`,
          75,
          "irs_990_eoi",
          ppUrl,
        );
        if (inserted1) result.signalsInserted++;

        // 2. Grant awarded
        if (totcntrbgfts >= MIN_GRANT_AMOUNT) {
          const conf = Math.min(90, Math.round(65 + (totcntrbgfts / 5_000_000) * 25));
          const inserted = await upsertSignal(
            facilityId,
            "grant_awarded",
            `irs990:grant:${ein}:${taxPd}`,
            conf,
            "irs_990_eoi",
            ppUrl,
          );
          if (inserted) result.signalsInserted++;
        }

        // 3. Bond issuance
        if (txexmptbndsend > 0) {
          const conf = Math.min(85, Math.round(60 + (txexmptbndsend / 10_000_000) * 25));
          const inserted = await upsertSignal(
            facilityId,
            "bond_issuance",
            `irs990:bond:${ein}:${taxPd}`,
            conf,
            "irs_990_eoi",
            ppUrl,
          );
          if (inserted) result.signalsInserted++;
        }

        // 4. Equipment aging
        if (agingRatio >= EQUIP_AGING_RATIO) {
          const conf = Math.min(80, Math.round(50 + (agingRatio - EQUIP_AGING_RATIO) * 300));
          const inserted = await upsertSignal(
            facilityId,
            "equipment_aging",
            `irs990:equip:${ein}:${taxPd}`,
            conf,
            "irs_990_eoi",
            ppUrl,
          );
          if (inserted) result.signalsInserted++;
        }

        // 5. IT investment
        if (infotech >= MIN_IT_SPEND) {
          const conf = Math.min(75, Math.round(50 + (infotech / 500_000) * 25));
          const inserted = await upsertSignal(
            facilityId,
            "it_investment",
            `irs990:it:${ein}:${taxPd}`,
            conf,
            "irs_990_eoi",
            ppUrl,
          );
          if (inserted) result.signalsInserted++;
        }
      }
    } catch (err) {
      logger.warn({ err, ein }, "irs_eoi row processing error");
      result.errors++;
    }
  }

  logger.info(result, "irs_eoi ingest complete");
  return result;
}
