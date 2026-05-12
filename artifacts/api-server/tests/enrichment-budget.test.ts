/**
 * Regression tests for the paid-validator monthly budget cap (task #12).
 *
 * The store-of-truth for both `current_month_spend` and `monthly_budget_limit`
 * is micros (1 cent = 10,000 micros). These tests guard against the obvious
 * implementation bug of comparing rounded cents — for example ZeroBounce calls
 * cost 8,000 micros each, well below 1 cent, so a cents-based check would
 * either over- or under-count whenever budgets aren't a clean multiple of
 * 10,000 micros.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock both paid email validators BEFORE importing the service so the
// service's `import { validateEmail }` picks up our stubs. This keeps the
// test fully offline and lets us assert exactly when each adapter ran.
const zbCalls: string[] = [];
const bouncerCalls: string[] = [];

vi.mock("../src/services/adapters/zerobounce", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/adapters/zerobounce")
  >("../src/services/adapters/zerobounce");
  return {
    ...actual,
    validateEmail: vi.fn(async (email: string) => {
      zbCalls.push(email);
      return {
        ok: true,
        status: "valid" as const,
        confidenceDelta: 25,
        attempts: 1,
        raw: { address: email, status: "valid" as const },
      };
    }),
  };
});

vi.mock("../src/services/adapters/bouncer", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/adapters/bouncer")
  >("../src/services/adapters/bouncer");
  return {
    ...actual,
    validateEmail: vi.fn(async (email: string) => {
      bouncerCalls.push(email);
      return {
        ok: true,
        status: "deliverable" as const,
        confidenceDelta: 25,
        attempts: 1,
        raw: { email, status: "deliverable" as const },
      };
    }),
  };
});

// Required env gates so the paid sources are considered active.
process.env.PAID_ENRICHMENT_ZEROBOUNCE_ENABLED = "true";
process.env.ZEROBOUNCE_API_KEY = "test-zb-key";
process.env.PAID_ENRICHMENT_BOUNCER_ENABLED = "true";
process.env.BOUNCER_API_KEY = "test-bouncer-key";

import { eq, sql } from "drizzle-orm";
import {
  db,
  enrichmentSourceApprovals,
  facilityContacts,
} from "@workspace/db";
import { enrichContact } from "../src/services/enrichment";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

let world: SeededWorld;

async function upsertApproval(
  source: "zerobounce" | "bouncer",
  spendMicros: number,
  budgetMicros: number | null,
) {
  await db
    .insert(enrichmentSourceApprovals)
    .values({
      source,
      approved: true,
      approvedAt: new Date(),
      currentMonthSpend: spendMicros,
      monthlyBudgetLimit: budgetMicros,
    })
    .onConflictDoUpdate({
      target: enrichmentSourceApprovals.source,
      set: {
        approved: true,
        approvedAt: new Date(),
        currentMonthSpend: spendMicros,
        monthlyBudgetLimit: budgetMicros,
        updatedAt: new Date(),
      },
    });
}

async function clearApprovals() {
  await db.delete(enrichmentSourceApprovals);
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await clearApprovals();
  if (world) await teardownWorld(world);
});

describe("paid validator monthly budget enforcement", () => {
  it("does NOT trip on sub-cent spend rounding (8,000 micros < 10,000 micros budget)", async () => {
    zbCalls.length = 0;
    bouncerCalls.length = 0;
    await clearApprovals();
    // 8,000 micros spend, 10,000 micros (= 1 cent) budget. Rounded to
    // cents both are "1 cent" — a cents-based check would falsely report
    // exhausted. The micros-based check must allow ZeroBounce to run.
    await upsertApproval("zerobounce", 8_000, 10_000);
    await upsertApproval("bouncer", 0, null);

    const r = await enrichContact(world.tenantA.contactId, { dryRun: true });

    expect(zbCalls.length).toBe(1);
    const zbSkip = r.sourcesSkipped.find((s) => s.source === "zerobounce");
    expect(zbSkip).toBeUndefined();
    expect(r.sourcesRun).toContain("zerobounce");
  });

  it("skips ZeroBounce with reason `budget_exceeded` and falls back to Bouncer when over cap", async () => {
    zbCalls.length = 0;
    bouncerCalls.length = 0;
    await clearApprovals();
    // ZeroBounce: spend has reached the cap exactly → must be paused.
    await upsertApproval("zerobounce", 10_000, 10_000);
    // Bouncer: approved with plenty of headroom.
    await upsertApproval("bouncer", 0, 1_000_000);

    const r = await enrichContact(world.tenantA.contactId, { dryRun: true });

    expect(zbCalls.length).toBe(0);
    const zbSkip = r.sourcesSkipped.find((s) => s.source === "zerobounce");
    expect(zbSkip?.reason).toBe("budget_exceeded");

    // Bouncer fallback fires because ZeroBounce never produced a clean
    // verdict (it was gated out before running).
    expect(bouncerCalls.length).toBe(1);
    expect(r.sourcesRun).toContain("bouncer");
  });

  it("treats a null monthly budget as no cap", async () => {
    zbCalls.length = 0;
    bouncerCalls.length = 0;
    await clearApprovals();
    await upsertApproval("zerobounce", 999_999_999, null);
    await upsertApproval("bouncer", 0, null);

    const r = await enrichContact(world.tenantA.contactId, { dryRun: true });

    expect(zbCalls.length).toBe(1);
    expect(r.sourcesRun).toContain("zerobounce");
    const zbSkip = r.sourcesSkipped.find((s) => s.source === "zerobounce");
    expect(zbSkip).toBeUndefined();
  });

  it("contact email is required for adapters even past the budget gate", async () => {
    zbCalls.length = 0;
    bouncerCalls.length = 0;
    await clearApprovals();
    await upsertApproval("zerobounce", 0, 1_000_000);
    await upsertApproval("bouncer", 0, 1_000_000);

    // Strip the contact's email so adapters early-return; the budget
    // gate must NOT mis-fire for an under-cap source.
    await db
      .update(facilityContacts)
      .set({ email: null })
      .where(eq(facilityContacts.id, world.tenantB.contactId));

    const r = await enrichContact(world.tenantB.contactId, { dryRun: true });

    expect(zbCalls.length).toBe(0);
    const zbSkip = r.sourcesSkipped.find((s) => s.source === "zerobounce");
    expect(zbSkip?.reason).toBe("skipped_no_input");

    // Restore for any later test that might depend on tenantB.
    await db
      .update(facilityContacts)
      .set({ email: `alex.restore-${world.tag}@example.test` })
      .where(eq(facilityContacts.id, world.tenantB.contactId));
  });
});

// Defensive use of `sql` import keeps the linter quiet if other tests later
// share this scaffolding via re-export.
void sql;
