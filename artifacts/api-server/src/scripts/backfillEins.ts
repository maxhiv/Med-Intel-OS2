/**
 * One-shot script: backfill facilities.ein from existing propublica_990 signals.
 * Signal value format: pp990:{ein}:{year}
 */
export {};

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

console.log("Backfilling facilities.ein from propublica_990 signals...");

const result = await db.execute(sql.raw(`
  UPDATE facilities f
  SET ein = lpad(split_part(ps.signal_value, ':', 2), 9, '0'),
      updated_at = now()
  FROM (
    SELECT DISTINCT ON (facility_id) facility_id, signal_value
    FROM purchase_signals
    WHERE source = 'propublica_990'
      AND signal_type = 'fiscal_year_end'
      AND signal_value LIKE 'pp990:%'
    ORDER BY facility_id, signal_value DESC
  ) ps
  WHERE f.id = ps.facility_id
    AND f.ein IS NULL
    AND length(split_part(ps.signal_value, ':', 2)) >= 1
`));

console.log(`Backfilled EINs for facilities.`);

const matched = await db.execute<{ matched: string }>(sql.raw(`
  SELECT COUNT(*) AS matched
  FROM facilities f
  INNER JOIN irs_990_raw i ON i.ein = f.ein
  WHERE f.ein IS NOT NULL
`));

console.log(`Facilities with matching 990 data: ${matched.rows[0]?.matched ?? 0}`);

const sample = await db.execute<{ name: string; ein: string }>(sql.raw(`
  SELECT f.name, f.ein
  FROM facilities f
  WHERE f.ein IS NOT NULL
  LIMIT 5
`));
console.log("Sample matched facilities:", sample.rows);

process.exit(0);
