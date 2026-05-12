/**
 * Tests for the one-shot CON facility backfill (task #31).
 *
 * Seeds a handful of facilities and `con_filings` rows whose `facility_id`
 * is NULL, runs the backfill, and asserts that:
 *   - matched rows get `facility_id` populated
 *   - genuinely unmatched rows stay NULL (no false positives)
 *   - a `purchase_signals` row is emitted per match (idempotently)
 *   - re-running the backfill is a no-op
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  facilities,
  conFilings,
  purchaseSignals,
} from "@workspace/db";
import { backfillConFilingFacilities } from "../src/services/conFacilityMatcher";

const tag = randomUUID().slice(0, 8);
const facIds: string[] = [];
const filingIds: string[] = [];
const filingUrls: string[] = [];

function uniqNpi(): string {
  return String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
}

beforeAll(async () => {
  // Tracked facilities — note the variations in name shape that the matcher
  // is supposed to handle (DBA, abbreviation drift).
  const seeded = await db
    .insert(facilities)
    .values([
      {
        npi: uniqNpi(),
        name: `Saint Mary Medical Center ${tag}`,
        facilityType: "hospital",
        state: "TX",
        city: "Austin",
      },
      {
        npi: uniqNpi(),
        name: `Mercy General Hospital ${tag}`,
        doingBusinessAs: `Mercy Sacramento ${tag}`,
        facilityType: "hospital",
        state: "TX",
        city: "Dallas",
      },
      {
        npi: uniqNpi(),
        name: `Cleveland Clinic Foundation ${tag}`,
        facilityType: "hospital",
        state: "OH",
        city: "Cleveland",
      },
    ])
    .returning({ id: facilities.id });
  facIds.push(...seeded.map((r) => r.id));

  // Filings: two should match (abbreviation drift in TX, NPI exact in OH),
  // one should stay unmatched (no overlap with any tracked facility).
  const f = await db
    .insert(conFilings)
    .values([
      {
        facilityId: null,
        state: "TX",
        applicantName: `St. Mary's Med Ctr ${tag}`,
        filingUrl: `https://example.test/filing/${tag}/1`,
        status: "filed",
      },
      {
        facilityId: null,
        state: "TX",
        applicantName: `Some Memorial Health Services dba Mercy Sacramento ${tag}`,
        filingUrl: `https://example.test/filing/${tag}/2`,
        status: "approved",
      },
      {
        facilityId: null,
        state: "TX",
        applicantName: `Totally Unrelated Surgery Center ${tag}`,
        filingUrl: `https://example.test/filing/${tag}/3`,
        status: "filed",
      },
    ])
    .returning({ id: conFilings.id, filingUrl: conFilings.filingUrl });
  filingIds.push(...f.map((r) => r.id));
  filingUrls.push(...f.map((r) => r.filingUrl as string));
});

afterAll(async () => {
  if (filingUrls.length > 0) {
    await db
      .delete(purchaseSignals)
      .where(inArray(purchaseSignals.signalValue, filingUrls));
  }
  if (filingIds.length > 0) {
    await db.delete(conFilings).where(inArray(conFilings.id, filingIds));
  }
  if (facIds.length > 0) {
    await db.delete(facilities).where(inArray(facilities.id, facIds));
  }
});

describe("backfillConFilingFacilities", () => {
  it("matches unmatched filings to tracked facilities and emits signals", async () => {
    const result = await backfillConFilingFacilities({ limit: 100 });

    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(result.matched).toBeGreaterThanOrEqual(2);
    expect(result.signalsInserted).toBeGreaterThanOrEqual(2);

    const rows = await db
      .select({
        id: conFilings.id,
        facilityId: conFilings.facilityId,
        applicantName: conFilings.applicantName,
      })
      .from(conFilings)
      .where(inArray(conFilings.id, filingIds));

    const byApplicant = new Map(rows.map((r) => [r.applicantName, r]));

    const stMary = byApplicant.get(`St. Mary's Med Ctr ${tag}`);
    expect(stMary?.facilityId).toBe(facIds[0]);

    const mercy = byApplicant.get(
      `Some Memorial Health Services dba Mercy Sacramento ${tag}`,
    );
    expect(mercy?.facilityId).toBe(facIds[1]);

    const unrelated = byApplicant.get(`Totally Unrelated Surgery Center ${tag}`);
    expect(unrelated?.facilityId).toBeNull();

    // Approved filing → con_approved at confidence 90.
    const [mercySignal] = await db
      .select()
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.facilityId, facIds[1]),
          eq(purchaseSignals.signalType, "con_approved"),
        ),
      )
      .limit(1);
    expect(mercySignal).toBeDefined();
    expect(mercySignal?.confidence).toBe(90);
  });

  it("is idempotent: a second run matches nothing new", async () => {
    const result = await backfillConFilingFacilities({ limit: 100 });
    // The previously-matched rows are no longer NULL, so they're not even
    // scanned. Only the genuinely-unmatched row remains in the queue.
    expect(result.matched).toBe(0);
    expect(result.signalsInserted).toBe(0);
  });

  it("respects emitSignals=false", async () => {
    // Reset our matched rows back to NULL and clear their signals so we can
    // re-run with signals disabled.
    await db
      .delete(purchaseSignals)
      .where(inArray(purchaseSignals.signalValue, filingUrls));
    await db
      .update(conFilings)
      .set({ facilityId: null })
      .where(inArray(conFilings.id, filingIds));

    const result = await backfillConFilingFacilities({
      limit: 100,
      emitSignals: false,
    });
    expect(result.matched).toBeGreaterThanOrEqual(2);
    expect(result.signalsInserted).toBe(0);

    const sigCount = await db
      .select({ id: purchaseSignals.id })
      .from(purchaseSignals)
      .where(inArray(purchaseSignals.signalValue, filingUrls));
    expect(sigCount.length).toBe(0);
  });
});
