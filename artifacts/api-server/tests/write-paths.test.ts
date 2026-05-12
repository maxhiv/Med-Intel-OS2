import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  accounts,
  subAccounts,
  sequences,
  sequenceSteps,
  campaignContacts,
  contactEnrollments,
  outreachDrafts,
  syncBatches,
  syncItems,
  crmContactsMap,
  facilityContacts,
  enrichmentSourceApprovals,
} from "@workspace/db";

// Mock the CRM adapter registry BEFORE the routes/services are imported so
// /batches/run exercises the real batch runner + crmPush plumbing without
// making outbound HTTP calls.
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
        crmContactId: `fake-contact-${counter}`,
        crmDraftId: `fake-task-${counter}`,
        raw: { fake: true },
      };
    },
  };
  return {
    ...actual,
    getCrmAdapter: (crmType: string | null | undefined) =>
      crmType === "ghl" || crmType === "hubspot" || crmType === "salesforce"
        ? fakeAdapter
        : null,
  };
});

const { createTestApp } = await import("./helpers/testApp");
const { seedWorld, teardownWorld } = await import("./helpers/seed");
type SeededWorld = Awaited<ReturnType<typeof seedWorld>>;

const app = createTestApp();
let world: SeededWorld;
let approvedDraftId: string;
let sequenceId: string;
let stepId: string;
let campaignContactId: string;
let enrollmentId: string;
let createdAdminAccountId: string | null = null;
let createdAdminSubAccountId: string | null = null;

function asUser(userId: string) {
  return { "x-test-user-id": userId };
}

beforeAll(async () => {
  world = await seedWorld();

  // The seeded world already contains a sequence + campaign_contact +
  // contact_enrollment for tenant A (so every RLS-protected table has at
  // least one row for the isolation probes). Reuse those instead of
  // re-inserting — the unique (campaign_id, contact_id) constraint on
  // campaign_contacts would reject a duplicate insert.
  sequenceId = world.tenantA.sequenceId;
  campaignContactId = world.tenantA.campaignContactId;
  enrollmentId = world.tenantA.enrollmentId;

  const [step] = await db
    .insert(sequenceSteps)
    .values({
      sequenceId,
      stepNum: 1,
      channel: "email",
      delayDays: 0,
      subjectLine: "hi",
      bodyTemplate: "Hello {{first_name}}",
    })
    .returning();
  stepId = step.id;

  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      enrollmentId,
      stepId: step.id,
      accountId: world.tenantA.accountId,
      contactId: world.tenantA.contactId,
      facilityId: world.tenantA.facilityId,
      channel: "email",
      subject: `e2e batch ${world.tag}`,
      body: "approved body",
      status: "approved",
    })
    .returning();
  approvedDraftId = draft.id;
});

afterAll(async () => {
  if (!world) return;

  // Custom cleanup for rows the helper teardown doesn't know about.
  await db
    .delete(crmContactsMap)
    .where(eq(crmContactsMap.accountId, world.tenantA.accountId));
  await db
    .delete(syncItems)
    .where(eq(syncItems.accountId, world.tenantA.accountId));

  if (createdAdminSubAccountId) {
    await db.delete(subAccounts).where(eq(subAccounts.id, createdAdminSubAccountId));
  }
  if (createdAdminAccountId) {
    await db.delete(accounts).where(eq(accounts.id, createdAdminAccountId));
  }

  // Drop any approval rows the admin enrichment-source tests touched so
  // global state doesn't leak between vitest runs.
  await db
    .delete(enrichmentSourceApprovals)
    .where(inArray(enrichmentSourceApprovals.source, ["apollo"]));

  await teardownWorld(world);
});

describe("POST /batches/run end-to-end push", () => {
  it("pushes the seeded approved draft and creates a sync_batches row", async () => {
    const before = await db
      .select()
      .from(syncBatches)
      .where(eq(syncBatches.accountId, world.tenantA.accountId));
    const beforeCount = before.length;

    const res = await request(app)
      .post("/batches/run")
      .set(asUser(world.tenantA.userId))
      .expect(200);

    expect(res.body.totalPushed).toBeGreaterThanOrEqual(1);
    expect(res.body.totalFailed).toBe(0);

    const [draft] = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.id, approvedDraftId));
    expect(draft.crmSyncedAt).toBeTruthy();
    expect(draft.crmDraftId).toMatch(/^fake-task-/);

    const after = await db
      .select()
      .from(syncBatches)
      .where(eq(syncBatches.accountId, world.tenantA.accountId));
    expect(after.length).toBe(beforeCount + 1);
    const newest = after.sort((a, b) => {
      const at = a.createdAt?.getTime() ?? 0;
      const bt = b.createdAt?.getTime() ?? 0;
      return bt - at;
    })[0];
    expect(newest.subAccountId).toBe(world.tenantA.subAccountId);
    expect(newest.status).toBe("complete");
    expect(newest.pushedCount).toBe(1);
    expect(newest.failedCount).toBe(0);

    const items = await db
      .select()
      .from(syncItems)
      .where(
        and(eq(syncItems.batchId, newest.id), eq(syncItems.localId, approvedDraftId)),
      );
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("complete");
  });
});

describe("POST /contacts/:id/enrich success path", () => {
  it("advances facility_contacts.lastEnrichedAt and persists confidence", async () => {
    // Force a stale lastEnrichedAt so we can assert it advances.
    const stale = new Date(Date.now() - 60_000);
    await db
      .update(facilityContacts)
      .set({ lastEnrichedAt: stale, confidenceScore: 50 })
      .where(eq(facilityContacts.id, world.tenantA.contactId));

    const res = await request(app)
      .post(`/contacts/${world.tenantA.contactId}/enrich`)
      .set(asUser(world.tenantA.userId))
      .send({})
      .expect(200);

    expect(res.body.contactId).toBe(world.tenantA.contactId);
    expect(Array.isArray(res.body.sourcesRun)).toBe(true);
    expect(res.body.sourcesRun.length).toBeGreaterThan(0);
    expect(res.body.confidenceAfter).toBeGreaterThanOrEqual(
      res.body.confidenceBefore,
    );

    const [c] = await db
      .select()
      .from(facilityContacts)
      .where(eq(facilityContacts.id, world.tenantA.contactId));
    expect(c.lastEnrichedAt).toBeTruthy();
    expect(c.lastEnrichedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });
});

describe("platform-admin CRUD: accounts, sub-accounts, enrichment sources", () => {
  it("POST /admin/accounts creates an account", async () => {
    const slug = `admin-${world.tag}`;
    const res = await request(app)
      .post("/admin/accounts")
      .set(asUser(world.platformAdminUserId))
      .send({
        name: `Admin Created ${world.tag}`,
        slug,
        planTier: "starter",
        defaultCrm: "ghl",
        status: "trial",
      })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.slug).toBe(slug);
    createdAdminAccountId = res.body.id;
  });

  it("POST /admin/sub-accounts creates a sub-account under that account", async () => {
    expect(createdAdminAccountId).toBeTruthy();
    const res = await request(app)
      .post("/admin/sub-accounts")
      .set(asUser(world.platformAdminUserId))
      .send({
        accountId: createdAdminAccountId,
        name: `admin sub ${world.tag}`,
        crmType: "ghl",
      })
      .expect(201);
    expect(res.body.accountId).toBe(createdAdminAccountId);
    createdAdminSubAccountId = res.body.id;
  });

  it("non-admin cannot hit POST /admin/accounts", async () => {
    await request(app)
      .post("/admin/accounts")
      .set(asUser(world.tenantA.userId))
      .send({ name: "denied", slug: `denied-${world.tag}` })
      .expect(403);
  });

  it("approve then revoke an enrichment source flips its approved flag", async () => {
    const approveRes = await request(app)
      .post("/admin/enrichment-sources/apollo/approve")
      .set(asUser(world.platformAdminUserId))
      .send({ notes: "ok for test" })
      .expect(200);
    expect(approveRes.body.source).toBe("apollo");
    expect(approveRes.body.approved).toBe(true);
    expect(approveRes.body.approvedAt).toBeTruthy();

    const [row] = await db
      .select()
      .from(enrichmentSourceApprovals)
      .where(eq(enrichmentSourceApprovals.source, "apollo"));
    expect(row.approved).toBe(true);

    const revokeRes = await request(app)
      .post("/admin/enrichment-sources/apollo/revoke")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    expect(revokeRes.body.source).toBe("apollo");
    expect(revokeRes.body.approved).toBe(false);
    expect(revokeRes.body.approvedAt).toBeNull();

    const [row2] = await db
      .select()
      .from(enrichmentSourceApprovals)
      .where(eq(enrichmentSourceApprovals.source, "apollo"));
    expect(row2.approved).toBe(false);
  });

  it("rejects unknown enrichment source slug", async () => {
    await request(app)
      .post("/admin/enrichment-sources/not_a_real_source/approve")
      .set(asUser(world.platformAdminUserId))
      .send({})
      .expect(400);
  });
});

describe("POST /signals/recompute", () => {
  it("recomputes signal scores across all facilities (admin only)", async () => {
    await request(app)
      .post("/signals/recompute")
      .set(asUser(world.tenantA.userId))
      .expect(403);

    const res = await request(app)
      .post("/signals/recompute")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    expect(typeof res.body.updated).toBe("number");
    expect(res.body.updated).toBeGreaterThanOrEqual(2);
  });
});

// silence unused-var lints; these are kept for symmetry with seed bookkeeping
void stepId;
void campaignContactId;
void enrollmentId;
void sequenceId;
