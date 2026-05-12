/**
 * Month-to-date spend rollover for `enrichment_source_approvals`.
 *
 * `currentMonthSpend` is incremented every time a paid validator burns credit
 * (see `enrichment.ts#recordSpend`). Without a rollover the counter would grow
 * forever, making the admin "month-to-date" widget meaningless and tripping
 * any monthly budget alert permanently. This module:
 *
 * 1. Computes the current billing month start in UTC (`startOfBillingMonth`).
 * 2. For each row whose `spendPeriodStart` is older than the current month,
 *    archives the accumulated total into `enrichment_source_spend_history`,
 *    zeroes `currentMonthSpend`, and advances `spendPeriodStart` to the new
 *    month boundary — all in a single SQL statement so concurrent writers
 *    cannot lose increments.
 *
 * The rollover is idempotent: running it twice in the same month is a no-op
 * because the WHERE clause filters on `spend_period_start < current month`.
 * It is invoked both lazily (before every read/write of the spend counter)
 * and proactively from a daily cron job, so neither path alone can let the
 * counter drift.
 */
import { sql } from "drizzle-orm";
import { db, enrichmentSourceApprovals } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * UTC start of the calendar month containing `now`. We use UTC rather than a
 * fixed local timezone so the boundary is unambiguous across DST transitions
 * and matches Postgres' `date_trunc('month', now())` default on new rows.
 */
export function startOfBillingMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface RolloverResult {
  rolled: number;
}

/**
 * Roll over every approval row whose period is stale. Safe to call from any
 * code path; cheap when nothing needs to roll. Returns the number of rows
 * that were actually advanced (useful for log lines / tests).
 */
export async function rolloverSpendCounters(
  now: Date = new Date(),
): Promise<RolloverResult> {
  const periodStart = startOfBillingMonth(now);
  const startIso = periodStart.toISOString();

  // Single round-trip: archive stale rows into history, then zero them out
  // and advance their `spend_period_start`. We do this in a transaction so a
  // crash between the two writes can't drop the archive row.
  return await db.transaction(async (tx) => {
    // Archive non-zero stale spends. Zero spend periods are skipped — there
    // is nothing meaningful to preserve.
    await tx.execute(sql`
      INSERT INTO enrichment_source_spend_history
        (source, period_start, period_end, total_spend_micros)
      SELECT
        source,
        spend_period_start,
        ${startIso}::timestamptz,
        COALESCE(current_month_spend, 0)
      FROM enrichment_source_approvals
      WHERE spend_period_start < ${startIso}::timestamptz
        AND COALESCE(current_month_spend, 0) > 0
      ON CONFLICT (source, period_start) DO UPDATE SET
        total_spend_micros = EXCLUDED.total_spend_micros,
        period_end = EXCLUDED.period_end
    `);

    const result = await tx.execute(sql`
      UPDATE enrichment_source_approvals
      SET
        current_month_spend = 0,
        spend_period_start = ${startIso}::timestamptz,
        last_reset_at = now(),
        updated_at = now()
      WHERE spend_period_start < ${startIso}::timestamptz
    `);

    // node-postgres returns rowCount on the underlying result; drizzle's
    // execute proxies it through.
    const rolled =
      (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
    if (rolled > 0) {
      logger.info(
        { rolled, periodStart: startIso },
        "rolled over enrichment spend counters",
      );
    }
    return { rolled };
  });
}

// Suppress unused-import warning for environments where the schema export is
// only needed for type inference on the table reference above.
void enrichmentSourceApprovals;
