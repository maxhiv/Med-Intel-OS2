/**
 * HCRIS Hospital Cost Reports Ingestor
 *
 * Pulls CMS HCRIS cost report data and emits `hcris_depreciation_spike`
 * signals when a facility's equipment depreciation ratio exceeds 40%.
 * Also upserts financial_documents with doc_type = 'hcris_cost_report'.
 *
 * Source: https://data.cms.gov/provider-compliance/cost-report/hospital-provider-cost-report
 * No API key required.
 */
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals, financialDocuments } from "@workspace/db";
import { logger } from "../lib/logger";

const HCRIS_API =
  "https://data.cms.gov/provider-compliance/cost-report/hospital-provider-cost-report/api/1/datastore/query";
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HcrisIngestResult {
  signalsInserted: number;
  errors: number;
}

interface HcrisRecord {
  PRVDR_NUM?: string;
  PROVIDER_NAME?: string;
  COST_RPT_STATUS_CD?: string;
  FY_BGN_DT?: string;
  FY_END_DT?: string;
  NET_PATIENT_REV_AMT?: string | number;
  TOT_OPERATING_EXPENSE_AMT?: string | number;
  TOT_ASSETS_EOY_AMT?: string | number;
  CAPITAL_EXPENDITURES?: string | number;
  ACCUM_DEPR_AMT?: string | number;
}

interface HcrisResponse {
  data?: HcrisRecord[];
  meta?: { count?: number };
}

async function matchFacility(
  providerNum: string | undefined,
  name: string | undefined,
): Promise<string | null> {
  if (providerNum) {
    const [byId] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.cmsId, providerNum))
      .limit(1);
    if (byId) return byId.id;
  }
  if (name) {
    const [byName] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(
        or(
          ilike(facilities.name, `%${name.slice(0, 40)}%`),
          ilike(facilities.doingBusinessAs, `%${name.slice(0, 40)}%`),
        ),
      )
      .limit(1);
    if (byName) return byName.id;
  }
  return null;
}

export async function ingestHcris(
  opts: { limit?: number } = {},
): Promise<HcrisIngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: HcrisIngestResult = { signalsInserted: 0, errors: 0 };

  try {
    const res = await fetch(HCRIS_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MedIntel/1.0",
      },
      body: JSON.stringify({
        limit,
        offset: 0,
        sort: [{ property: "FY_END_DT", order: "desc" }],
        conditions: [
          {
            property: "COST_RPT_STATUS_CD",
            value: "2",
            operator: "=",
          },
        ],
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "HCRIS API error");
      result.errors += 1;
      return result;
    }

    const body = (await res.json()) as HcrisResponse;
    const records = body.data ?? [];

    for (const rec of records) {
      try {
        const facilityId = await matchFacility(rec.PRVDR_NUM, rec.PROVIDER_NAME);
        if (!facilityId) {
          await sleep(DELAY_MS);
          continue;
        }

        const fiscalYear = rec.FY_END_DT
          ? new Date(rec.FY_END_DT).getFullYear()
          : new Date().getFullYear();

        const totalAssets = Number(rec.TOT_ASSETS_EOY_AMT ?? 0);
        const accumDepr = Number(rec.ACCUM_DEPR_AMT ?? 0);
        const capEx = Number(rec.CAPITAL_EXPENDITURES ?? 0);
        const netPatientRev = Number(rec.NET_PATIENT_REV_AMT ?? 0);
        const operatingExp = Number(rec.TOT_OPERATING_EXPENSE_AMT ?? 0);

        const deprecRatio = totalAssets > 0 ? accumDepr / totalAssets : 0;

        await db
          .insert(financialDocuments)
          .values({
            facilityId,
            docType: "hcris_cost_report",
            fiscalYear,
            parsedJson: {
              prvdrNum: rec.PRVDR_NUM,
              providerName: rec.PROVIDER_NAME,
              costRptStatusCd: rec.COST_RPT_STATUS_CD,
              fyBgnDt: rec.FY_BGN_DT,
              fyEndDt: rec.FY_END_DT,
              deprecRatio: deprecRatio.toFixed(4),
              accumDepr,
              totalAssets,
              capitalExpenditures: capEx,
            },
            netPatientRevenue: netPatientRev > 0 ? netPatientRev : null,
            operatingIncome:
              operatingExp > 0 && netPatientRev > 0
                ? netPatientRev - operatingExp
                : null,
            capitalExpenditures: capEx > 0 ? capEx : null,
          })
          .onConflictDoNothing();

        if (deprecRatio > 0.4) {
          const signalValue = `hcris:${rec.PRVDR_NUM}:${fiscalYear}`;
          const [exists] = await db
            .select({ id: purchaseSignals.id })
            .from(purchaseSignals)
            .where(
              and(
                eq(purchaseSignals.facilityId, facilityId),
                eq(purchaseSignals.signalType, "hcris_depreciation_spike"),
                eq(purchaseSignals.signalValue, signalValue),
              ),
            )
            .limit(1);

          if (!exists) {
            const confidence = Math.round(
              Math.min(100, 50 + (deprecRatio - 0.4) * 100),
            );
            await db.insert(purchaseSignals).values({
              facilityId,
              signalType: "hcris_depreciation_spike",
              signalValue,
              confidence,
              source: "hcris",
              metadata: null,
              isActive: true,
            });
            result.signalsInserted += 1;
          }

          // Populate fiscal year end month from the cost report end date.
          // Only write if we're the authoritative source or no source is set.
          if (rec.FY_END_DT) {
            const fyeMonth = new Date(rec.FY_END_DT).getMonth() + 1;
            await db
              .update(facilities)
              .set({ fiscalYearEndMonth: fyeMonth, fiscalYearEndSource: "hcris", updatedAt: new Date() })
              .where(
                sql`${facilities.id} = ${facilityId} AND (${facilities.fiscalYearEndSource} IS NULL OR ${facilities.fiscalYearEndSource} = 'hcris')`,
              );
          }
        }
      } catch (err) {
        logger.warn({ err, prvdrNum: rec.PRVDR_NUM }, "HCRIS record error");
        result.errors += 1;
      }

      await sleep(DELAY_MS);
    }
  } catch (err) {
    logger.error({ err }, "HCRIS ingest fetch error");
    result.errors += 1;
  }

  logger.info(result, "hcris ingest complete");
  return result;
}
