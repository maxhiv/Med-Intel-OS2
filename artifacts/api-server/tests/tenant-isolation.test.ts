import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers/testApp";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

const app = createTestApp();
let world: SeededWorld;

function asUser(userId: string) {
  return { "x-test-user-id": userId };
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  if (world) await teardownWorld(world);
});

describe("tenant isolation: account A cannot read account B's data", () => {
  it("/facilities returns only A's facilities", async () => {
    const res = await request(app)
      .get("/facilities")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    const ids = res.body.data.map((f: { id: string }) => f.id);
    expect(ids).toContain(world.tenantA.facilityId);
    expect(ids).not.toContain(world.tenantB.facilityId);
  });

  it("GET /facilities/:id of B as A → 404", async () => {
    await request(app)
      .get(`/facilities/${world.tenantB.facilityId}`)
      .set(asUser(world.tenantA.userId))
      .expect(404);
  });

  it("PATCH /facilities/:id of B as A → 404 (no mutation)", async () => {
    await request(app)
      .patch(`/facilities/${world.tenantB.facilityId}`)
      .set(asUser(world.tenantA.userId))
      .send({ name: "PWNED" })
      .expect(404);
  });

  it("GET /facilities/:id/contacts of B as A → 404", async () => {
    await request(app)
      .get(`/facilities/${world.tenantB.facilityId}/contacts`)
      .set(asUser(world.tenantA.userId))
      .expect(404);
  });

  it("POST /contacts/:id/enrich of B's contact as A → 403", async () => {
    await request(app)
      .post(`/contacts/${world.tenantB.contactId}/enrich`)
      .set(asUser(world.tenantA.userId))
      .send({ dryRun: true })
      .expect(403);
  });

  it("/campaigns returns only A's campaigns", async () => {
    const res = await request(app)
      .get("/campaigns")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(world.tenantA.campaignId);
    expect(ids).not.toContain(world.tenantB.campaignId);
  });

  it("GET /campaigns/:id of B as A → 404", async () => {
    await request(app)
      .get(`/campaigns/${world.tenantB.campaignId}`)
      .set(asUser(world.tenantA.userId))
      .expect(404);
  });

  it("PATCH /campaigns/:id of B as A → 404", async () => {
    await request(app)
      .patch(`/campaigns/${world.tenantB.campaignId}`)
      .set(asUser(world.tenantA.userId))
      .send({ name: "stolen" })
      .expect(404);
  });

  it("POST /campaigns with B's subAccountId as A → 403", async () => {
    await request(app)
      .post("/campaigns")
      .set(asUser(world.tenantA.userId))
      .send({ name: "x", subAccountId: world.tenantB.subAccountId })
      .expect(403);
  });

  it("POST /campaigns/:id/contacts cannot enroll B's contacts when A owns campaign", async () => {
    // Use A's campaign with B's contact id → should reject all
    await request(app)
      .post(`/campaigns/${world.tenantA.campaignId}/contacts`)
      .set(asUser(world.tenantA.userId))
      .send({ contactIds: [world.tenantB.contactId] })
      .expect(403);
  });

  it("POST /campaigns/:id/contacts on B's campaign as A → 404", async () => {
    await request(app)
      .post(`/campaigns/${world.tenantB.campaignId}/contacts`)
      .set(asUser(world.tenantA.userId))
      .send({ contactIds: [world.tenantA.contactId] })
      .expect(404);
  });

  it("/drafts returns only A's drafts", async () => {
    const res = await request(app)
      .get("/drafts")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(world.tenantA.draftId);
    expect(ids).not.toContain(world.tenantB.draftId);
  });

  it("GET /drafts/:id of B as A → 404", async () => {
    await request(app)
      .get(`/drafts/${world.tenantB.draftId}`)
      .set(asUser(world.tenantA.userId))
      .expect(404);
  });

  it("PATCH /drafts/:id of B as A → 404", async () => {
    await request(app)
      .patch(`/drafts/${world.tenantB.draftId}`)
      .set(asUser(world.tenantA.userId))
      .send({ subject: "PWNED" })
      .expect(404);
  });

  it("POST /drafts/:id/approve of B as A → 404", async () => {
    await request(app)
      .post(`/drafts/${world.tenantB.draftId}/approve`)
      .set(asUser(world.tenantA.userId))
      .expect(404);
  });

  it("POST /drafts/:id/reject of B as A → 404", async () => {
    await request(app)
      .post(`/drafts/${world.tenantB.draftId}/reject`)
      .set(asUser(world.tenantA.userId))
      .send({ reason: "x" })
      .expect(404);
  });

  it("/reports/templates returns A's templates and system templates but not B's", async () => {
    const res = await request(app)
      .get("/reports/templates")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    const ids = res.body.map((t: { id: string }) => t.id);
    expect(ids).toContain(world.tenantA.templateId);
    expect(ids).toContain(world.systemTemplateId);
    expect(ids).not.toContain(world.tenantB.templateId);
  });

  it("POST /reports/run on B's template as A → 403", async () => {
    await request(app)
      .post("/reports/run")
      .set(asUser(world.tenantA.userId))
      .send({ templateId: world.tenantB.templateId })
      .expect(403);
  });

  it("POST /reports/run on system template as A → 200", async () => {
    await request(app)
      .post("/reports/run")
      .set(asUser(world.tenantA.userId))
      .send({ templateId: world.systemTemplateId })
      .expect(200);
  });

  it("dashboard summary for A excludes B's facilities/contacts", async () => {
    const res = await request(app)
      .get("/dashboard/summary")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    expect(res.body.totalFacilities).toBe(1);
    expect(res.body.totalContacts).toBe(1);
  });

  it("dashboard top-facilities for A excludes B", async () => {
    const res = await request(app)
      .get("/dashboard/top-facilities")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    expect(ids).toContain(world.tenantA.facilityId);
    expect(ids).not.toContain(world.tenantB.facilityId);
  });

  it("admin endpoints reject non-platform-admin users", async () => {
    await request(app)
      .get("/admin/accounts")
      .set(asUser(world.tenantA.userId))
      .expect(403);
  });
});
