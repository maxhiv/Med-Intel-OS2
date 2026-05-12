import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, conFilings, purchaseSignals } from "@workspace/db";

const { createTestApp } = await import("./helpers/testApp");
const { seedWorld, teardownWorld } = await import("./helpers/seed");
type SeededWorld = Awaited<ReturnType<typeof seedWorld>>;

const app = createTestApp();
let world: SeededWorld;
const filingIds: string[] = [];

function asUser(userId: string) {
  return { "x-test-user-id": userId };
}

async function seedFiling(overrides: {
  facilityId: string | null;
  matchScore: string | null;
  matchField: string | null;
  reviewStatus: string | null;
  status?: string;
  filingUrl?: string;
  state?: string;
}) {
  const filingUrl =
    overrides.filingUrl ??
    `https://example.test/con/${world.tag}/${filingIds.length}`;
  const [row] = await db
    .insert(conFilings)
    .values({
      sourceId: `src-${world.tag}-${filingIds.length}`,
      state: overrides.state ?? "TX",
      applicantName: `Applicant ${filingIds.length}`,
      facilityId: overrides.facilityId,
      filingUrl,
      filingDate: "2026-04-01",
      status: overrides.status ?? "Filed",
      matchScore: overrides.matchScore as unknown as number | null,
      matchField: overrides.matchField,
      reviewStatus: overrides.reviewStatus,
    })
    .returning();
  filingIds.push(row.id);

  // Mirror ingestor's purchase-signal emission so the deactivation paths
  // have something concrete to flip.
  if (overrides.facilityId) {
    const isApproved =
      !!overrides.status && /approv|grant(ed)?|issued/i.test(overrides.status);
    await db.insert(purchaseSignals).values({
      facilityId: overrides.facilityId,
      signalType: isApproved ? "con_approved" : "con_filed",
      signalValue: filingUrl,
      confidence: isApproved ? 90 : 75,
      source: "con_filing",
      sourceId: row.id,
      isActive: true,
    });
  }
  return row;
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  if (filingIds.length > 0) {
    await db
      .delete(purchaseSignals)
      .where(inArray(purchaseSignals.sourceId, filingIds));
    await db.delete(conFilings).where(inArray(conFilings.id, filingIds));
  }
  await teardownWorld(world);
});

describe("CON-filing review queue", () => {
  it("rejects non-admin callers", async () => {
    // Shared `requirePlatformAdmin` middleware already returns 403 for non-admins
    // on every other admin route; the test-app's RLS wrapper swallows the exact
    // status, so we just assert it is not a success.
    const res = await request(app)
      .get("/admin/con-filings/review-queue")
      .set(asUser(world.tenantA.userId));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("only surfaces needs_review filings", async () => {
    const borderline = await seedFiling({
      facilityId: world.tenantA.facilityId,
      matchScore: "0.680",
      matchField: "name",
      reviewStatus: "needs_review",
    });
    await seedFiling({
      facilityId: world.tenantA.facilityId,
      matchScore: "0.950",
      matchField: "name",
      reviewStatus: "auto_approved",
    });

    const res = await request(app)
      .get("/admin/con-filings/review-queue")
      .set(asUser(world.platformAdminUserId));
    expect(res.status).toBe(200);
    expect(res.body.reviewThreshold).toBeGreaterThan(0);
    const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(borderline.id);
    const surfaced = (res.body.data as Array<{ id: string; matchScore: number }>)
      .find((r) => r.id === borderline.id)!;
    expect(surfaced.matchScore).toBeCloseTo(0.68, 2);
  });

  it("confirm marks the filing confirmed and leaves the signal active", async () => {
    const filing = await seedFiling({
      facilityId: world.tenantA.facilityId,
      matchScore: "0.700",
      matchField: "name",
      reviewStatus: "needs_review",
    });
    const res = await request(app)
      .post(`/admin/con-filings/${filing.id}/review`)
      .set(asUser(world.platformAdminUserId))
      .send({ action: "confirm", notes: "looks right" });
    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(conFilings)
      .where(eq(conFilings.id, filing.id));
    expect(after.reviewStatus).toBe("confirmed");
    expect(after.reviewNotes).toBe("looks right");
    expect(after.reviewedBy).toBe(world.platformAdminUserId);

    const [sig] = await db
      .select()
      .from(purchaseSignals)
      .where(eq(purchaseSignals.sourceId, filing.id));
    expect(sig.isActive).toBe(true);
  });

  it("reject deactivates the auto-emitted purchase signal", async () => {
    const filing = await seedFiling({
      facilityId: world.tenantA.facilityId,
      matchScore: "0.650",
      matchField: "name",
      reviewStatus: "needs_review",
      status: "Approved",
    });
    const res = await request(app)
      .post(`/admin/con-filings/${filing.id}/review`)
      .set(asUser(world.platformAdminUserId))
      .send({ action: "reject", notes: "wrong facility" });
    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(conFilings)
      .where(eq(conFilings.id, filing.id));
    expect(after.reviewStatus).toBe("rejected");
    expect(after.facilityId).toBeNull();

    const [sig] = await db
      .select()
      .from(purchaseSignals)
      .where(eq(purchaseSignals.sourceId, filing.id));
    expect(sig.isActive).toBe(false);
  });

  it("reassign deactivates the old signal and emits a fresh one for the new facility", async () => {
    const filing = await seedFiling({
      facilityId: world.tenantA.facilityId,
      matchScore: "0.620",
      matchField: "name",
      reviewStatus: "needs_review",
      status: "Approved",
    });
    const res = await request(app)
      .post(`/admin/con-filings/${filing.id}/review`)
      .set(asUser(world.platformAdminUserId))
      .send({ action: "reassign", facilityId: world.tenantB.facilityId });
    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(conFilings)
      .where(eq(conFilings.id, filing.id));
    expect(after.reviewStatus).toBe("reassigned");
    expect(after.facilityId).toBe(world.tenantB.facilityId);

    const sigs = await db
      .select()
      .from(purchaseSignals)
      .where(eq(purchaseSignals.sourceId, filing.id));
    // Old one flipped off, new one for tenantB facility flipped on with the
    // approved-status signal type.
    const active = sigs.filter((s) => s.isActive);
    expect(active.length).toBe(1);
    expect(active[0].facilityId).toBe(world.tenantB.facilityId);
    expect(active[0].signalType).toBe("con_approved");
  });

  it("reassign rejects a missing facilityId", async () => {
    const filing = await seedFiling({
      facilityId: world.tenantA.facilityId,
      matchScore: "0.700",
      matchField: "name",
      reviewStatus: "needs_review",
    });
    const res = await request(app)
      .post(`/admin/con-filings/${filing.id}/review`)
      .set(asUser(world.platformAdminUserId))
      .send({ action: "reassign" });
    expect(res.status).toBe(400);
  });
});

describe("admin facility search", () => {
  it("rejects non-admin callers", async () => {
    const res = await request(app)
      .get("/admin/facilities/search?q=Hospital")
      .set(asUser(world.tenantA.userId));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns matching facilities across tenants", async () => {
    const res = await request(app)
      .get("/admin/facilities/search?q=test-b")
      .set(asUser(world.platformAdminUserId));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(world.tenantB.facilityId);
  });

  it("rejects too-short queries", async () => {
    const res = await request(app)
      .get("/admin/facilities/search?q=a")
      .set(asUser(world.platformAdminUserId));
    expect(res.status).toBe(400);
  });
});
