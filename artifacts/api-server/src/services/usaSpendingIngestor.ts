/**
 * USASpending.gov ingestor — free public source, no API key required.
 *
 * Searches federal award data (grants and cooperative agreements) for each
 * tracked facility by recipient name. NIH awards are emitted as `nih_grant`
 * signals; all other federal grants become `grant_awarded` signals. Both
 * signal types indicate research expansion and capital investment capacity.
 *
 * Docs: https://api.usaspending.gov
 */
import { and, eq, sql } from "drizzle-orm";
import { db, facilities, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";

const USA_SPENDING_API =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

interface UsaAward {
  "Award ID"?: string;
  "Recipient Name"?: string;
  "Award Amount"?: number;
  "Awarding Agency"?: string;
  "Award Date"?: string;
  generated_internal_id?: string;
}

interface UsaSpendingResponse {
  results?: UsaAward[];
}

function isNihAward(agencyName: string | undefined): boolean {
  return /national institutes of health/i.test(agencyName ?? "");
}

export interface IngestResult {
  facilitiesScanned: number;
  signalsInserted: number;
  errors: number;
}

export async function ingestUsaSpending(
  opts: { limit?: number } = {},
): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 500));
  const result: IngestResult = {
    facilitiesScanned: 0,
    signalsInserted: 0,
    errors: 0,
  };

  const targets = await db
    .select()
    .from(facilities)
    .orderBy(sql`${facilities.lastScrapedAt} NULLS FIRST`)
    .limit(limit);

  for (const f of targets) {
    result.facilitiesScanned += 1;
    try {
      const body = {
        filters: {
          recipient_search_text: [f.name],
          // 02 = block grant, 03 = formula grant, 04 = project grant,
          // 05 = cooperative agreement
          award_type_codes: ["02", "03", "04", "05"],
          time_period: [{ start_date: "2022-01-01", end_date: todayStr() }],
        },
        fields: [
          "Award ID",
          "Recipient Name",
          "Award Amount",
          "Awarding Agency",
          "Award Date",
          "generated_internal_id",
        ],
        limit: 5,
        page: 1,
        sort: "Award Amount",
        order: "desc",
        subawards: false,
      };

      const res = await fetch(USA_SPENDING_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "MedIntel/1.0",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status !== 404) result.errors += 1;
        continue;
      }
      const json = (await res.json()) as UsaSpendingResponse;
      const awards = json.results ?? [];
      if (awards.length === 0) continue;

      for (const award of awards) {
        const internalId = award.generated_internal_id ?? award["Award ID"];
        if (!internalId) continue;

        const isNih = isNihAward(award["Awarding Agency"]);
        const signalType = isNih ? ("nih_grant" as const) : ("grant_awarded" as const);
        const confidence = isNih ? 80 : 72;

        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.facilityId, f.id),
              eq(purchaseSignals.signalType, signalType),
              eq(purchaseSignals.signalValue, internalId),
            ),
          )
          .limit(1);
        if (exists) continue;

        await db.insert(purchaseSignals).values({
          facilityId: f.id,
          signalType,
          signalValue: internalId,
          confidence,
          source: "usa_spending",
          isActive: true,
        });
        result.signalsInserted += 1;
      }

      await db
        .update(facilities)
        .set({ lastScrapedAt: new Date(), updatedAt: new Date() })
        .where(eq(facilities.id, f.id));
    } catch (err) {
      logger.warn({ err, facilityId: f.id }, "usa_spending fetch error");
      result.errors += 1;
      continue;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "usa_spending ingest complete");
  return result;
}
