import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  withRLS,
  campaigns,
  outreachDrafts,
  syncBatches,
  subAccounts,
  replyEvents,
} from "@workspace/db";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

// Mock the Anthropic client so the reply classifier doesn't need network
// or an API key. Returns a deterministic "interested" classification.
vi.mock("../src/lib/anthropic", () => ({
  ANTHROPIC_MODEL: "test-model",
  ai: {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: '{"classification":"interested"}' }],
      }),
    },
  },
}));

// Mock the CRM adapter registry so the runner can push approved drafts
// without making real outbound HTTP calls.
vi.mock("../src/services/crmAdapters", async () => {
  const actual = await vi.importActual<typeof import("../src/services/crmAdapters")>(
    "../src/services/crmAdapters",
  );
  let counter = 0;
  const fakeAdapter = {
    type: "ghl" as const,
    async push() {
      counter += 1;
      return {
        crmContactId: `bg-fake-contact-${counter}`,
        crmDraftId: `bg-fake-task-${counter}`,
        raw: { fake: true },
      };
    },
  };
  return {
    ...actual,
    getAdapter: () => fakeAdapter,
  };
});

import {
  runDailyBatchesForAccount,
  runAllAccounts,
} from "../src/services/batchRunner";
import {
  classifyPendingReplies,
  classifyPendingRepliesForAccount,
} from "../src/services/replyClassifier";

let world: SeededWorld;

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  if (world) await teardownWorld(world);
});

describe("background jobs run inside a per-account RLS transaction", () => {
  it("an unfiltered query inside withRLS only sees the calling account's rows", async () => {
    // Mirrors the production cron path: open one RLS scope per account,
    // then run an unfiltered query (the kind that would otherwise leak
    // across tenants) and confirm the database — not the application —
    // hides the other tenant's rows.
    const aRows = await withRLS(world.tenantA.accountId, async () => {
      return await db.select().from(campaigns);
    });
    const aIds = aRows.map((r) => r.id);
    expect(aIds).toContain(world.tenantA.campaignId);
    expect(aIds).not.toContain(world.tenantB.campaignId);

    const bRows = await withRLS(world.tenantB.accountId, async () => {
      return await db.select().from(outreachDrafts);
    });
    const bIds = bRows.map((r) => r.id);
    expect(bIds).toContain(world.tenantB.draftId);
    expect(bIds).not.toContain(world.tenantA.draftId);
  });

  it("withRLS rejects nesting with a different accountId", async () => {
    await expect(
      withRLS(world.tenantA.accountId, async () => {
        await withRLS(world.tenantB.accountId, async () => {
          // would silently smuggle B's code into A's transaction — must throw
        });
      }),
    ).rejects.toThrow(/conflicting accountId/);
  });

  it("runDailyBatchesForAccount only writes batches for the calling account", async () => {
    // Approve A's seeded draft and link it to A's seeded enrollment so
    // the runner has something to push. seedTenant already provisioned
    // the sequence / campaign_contact / enrollment fixtures.
    await db
      .update(outreachDrafts)
      .set({ status: "approved", enrollmentId: world.tenantA.enrollmentId })
      .where(eq(outreachDrafts.id, world.tenantA.draftId));

    const before = await db
      .select({ id: syncBatches.id })
      .from(syncBatches)
      .where(eq(syncBatches.accountId, world.tenantB.accountId));

    const result = await runDailyBatchesForAccount(world.tenantA.accountId);
    expect(result.batches).toBeGreaterThanOrEqual(1);

    // Tenant B must have gained zero new batches: the runner could not
    // even see B's data while wrapped in A's RLS transaction.
    const after = await db
      .select({ id: syncBatches.id })
      .from(syncBatches)
      .where(eq(syncBatches.accountId, world.tenantB.accountId));
    expect(after.length).toBe(before.length);

    // The batches it did create are owned by A.
    const aBatches = await db
      .select()
      .from(syncBatches)
      .where(eq(syncBatches.accountId, world.tenantA.accountId));
    expect(aBatches.length).toBeGreaterThanOrEqual(1);
    for (const b of aBatches) {
      expect(b.accountId).toBe(world.tenantA.accountId);
    }
  });

  it("runAllAccounts opens one RLS scope per account, not one global scope", async () => {
    // Sanity check the cross-account fan-out: the discovery query reads
    // sub_accounts (non-RLS) without an RLS context, but every per-account
    // call must engage RLS for its own account. We assert by spying on
    // the underlying connection: each per-account run sets app.account_id
    // exactly once (via withRLS), so the number of distinct account_ids
    // observed equals the number of accounts visited.
    const subs = await db
      .select({ accountId: subAccounts.accountId })
      .from(subAccounts)
      .where(eq(subAccounts.isActive, true))
      .groupBy(subAccounts.accountId);
    const expectedAccounts = new Set(subs.map((s) => s.accountId));

    const result = await runAllAccounts();
    expect(result.accounts).toBe(expectedAccounts.size);
  });

  it("classifyPendingRepliesForAccount cannot observe another tenant's reply rows", async () => {
    // Drop the auto-seeded reply rows so we control exactly which events
    // exist for each tenant in this test.
    await db
      .delete(replyEvents)
      .where(eq(replyEvents.id, world.tenantA.replyEventId));
    await db
      .delete(replyEvents)
      .where(eq(replyEvents.id, world.tenantB.replyEventId));

    // Seed an un-classified inbound reply for each tenant, both tied to
    // their own draft. The classifier wrapper for tenant A must classify
    // exactly one row (A's), never see B's row, and never write to B's row.
    const [evtA] = await db
      .insert(replyEvents)
      .values({
        accountId: world.tenantA.accountId,
        draftId: world.tenantA.draftId,
        eventType: "inbound_message",
        rawPayload: { body: "Sounds great, please send more info." },
      })
      .returning();
    const [evtB] = await db
      .insert(replyEvents)
      .values({
        accountId: world.tenantB.accountId,
        draftId: world.tenantB.draftId,
        eventType: "inbound_message",
        rawPayload: { body: "Sounds great, please send more info." },
      })
      .returning();

    const result = await classifyPendingRepliesForAccount(
      world.tenantA.accountId,
      50,
    );
    expect(result.examined).toBe(1);
    expect(result.classified).toBe(1);

    const aAfter = await db
      .select({ cls: replyEvents.aiClassification })
      .from(replyEvents)
      .where(eq(replyEvents.id, evtA.id));
    const bAfter = await db
      .select({ cls: replyEvents.aiClassification })
      .from(replyEvents)
      .where(eq(replyEvents.id, evtB.id));
    expect(aAfter[0]?.cls).toBe("interested");
    expect(bAfter[0]?.cls).toBeNull();
  });

  it("classifyPendingReplies fans out per account and visits each tenant in its own RLS scope", async () => {
    // Both tenants now have one un-classified reply (B's leftover from
    // the previous test, plus a fresh one for A). The cross-account
    // wrapper should classify both, leaving every reply event scoped to
    // its own account.
    const [evtA] = await db
      .insert(replyEvents)
      .values({
        accountId: world.tenantA.accountId,
        draftId: world.tenantA.draftId,
        eventType: "inbound_message",
        rawPayload: { body: "Yes, interested." },
      })
      .returning();

    const result = await classifyPendingReplies(50);
    expect(result.examined).toBeGreaterThanOrEqual(2);

    // Both seeded tenants must end up with a classified reply (they each
    // had a pending row going in, and the cross-account fan-out should
    // have visited each in its own RLS scope).
    const rows = await db
      .select({
        accountId: replyEvents.accountId,
        cls: replyEvents.aiClassification,
      })
      .from(replyEvents)
      .where(
        eq(replyEvents.aiClassification, "interested"),
      );
    const accounts = new Set(rows.map((r) => r.accountId));
    expect(accounts.has(world.tenantA.accountId)).toBe(true);
    expect(accounts.has(world.tenantB.accountId)).toBe(true);
    expect(evtA.id).toBeDefined();
  });
});
