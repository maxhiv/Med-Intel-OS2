import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { z } from "zod";
import {
  HealthCheckResponse,
  GetMeResponse,
  GetDashboardSummaryResponse,
  GetTopFacilitiesResponse,
  GetRecentSignalsResponse,
  ListFacilitiesResponse,
  GetFacilityResponse,
  UpdateFacilityResponse,
  GetFacilitySignalsResponse,
  GetFacilityContactsResponse,
  GetFacilityEquipmentResponse,
  EnrichContactResponse,
  ListCampaignsResponse,
  ListCampaignsResponseItem,
  GetCampaignResponse,
  UpdateCampaignResponse,
  ListCampaignContactsResponse,
  ListSequencesResponse,
  ListSequencesResponseItem,
  GetSequenceResponse,
  ListDraftsResponse,
  GetDraftResponse,
  UpdateDraftResponse,
  ApproveDraftResponse,
  RejectDraftResponse,
  ListBatchesResponse,
  RunBatchesResponse,
  ListReportTemplatesResponse,
  ListReportTemplatesResponseItem,
  RunReportResponse,
  ListReportRunsResponse,
  AdminListAccountsResponse,
  AdminListSubAccountsResponse,
  AdminListUsersResponse,
  AdminListEnrichmentSourcesResponse,
  AdminPlatformStatsResponse,
} from "@workspace/api-zod";
import { createTestApp } from "./helpers/testApp";
import { seedWorld, teardownWorld, type SeededWorld } from "./helpers/seed";

const app = createTestApp();
let world: SeededWorld;

function asUser(userId: string) {
  return { "x-test-user-id": userId };
}

function assertParse(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  value: unknown,
  label: string,
) {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new Error(`${label} failed schema: ${JSON.stringify(r.error)}`);
  }
  expect(r.success).toBe(true);
}

// Inline schemas for endpoints that don't have generated zod exports
// (the orval setup emits TS types only for these two response shapes).
const AddCampaignContactsResultSchema = z.object({
  added: z.number().optional(),
  skipped: z.number().optional(),
  requested: z.number().optional(),
  rejectedCrossTenant: z.number().optional(),
});
const GenerateDraftsResultSchema = z.object({
  queued: z.number().optional(),
  generated: z.number().optional(),
  skipped: z.number().optional(),
});

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  if (world) await teardownWorld(world);
});

describe("contract tests: responses match generated zod schemas", () => {
  it("GET /healthz", async () => {
    const res = await request(app).get("/healthz").expect(200);
    assertParse(HealthCheckResponse, res.body, "HealthCheckResponse");
  });

  it("GET /me", async () => {
    const res = await request(app)
      .get("/me")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetMeResponse, res.body, "GetMeResponse");
  });

  it("GET /dashboard/summary", async () => {
    const res = await request(app)
      .get("/dashboard/summary")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetDashboardSummaryResponse, res.body, "GetDashboardSummaryResponse");
  });

  it("GET /dashboard/top-facilities", async () => {
    const res = await request(app)
      .get("/dashboard/top-facilities")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetTopFacilitiesResponse, res.body, "GetTopFacilitiesResponse");
  });

  it("GET /dashboard/recent-signals", async () => {
    const res = await request(app)
      .get("/dashboard/recent-signals")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetRecentSignalsResponse, res.body, "GetRecentSignalsResponse");
  });

  it("GET /facilities", async () => {
    const res = await request(app)
      .get("/facilities")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListFacilitiesResponse, res.body, "ListFacilitiesResponse");
  });

  it("GET /facilities/:id", async () => {
    const res = await request(app)
      .get(`/facilities/${world.tenantA.facilityId}`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetFacilityResponse, res.body, "GetFacilityResponse");
  });

  it("PATCH /facilities/:id", async () => {
    const res = await request(app)
      .patch(`/facilities/${world.tenantA.facilityId}`)
      .set(asUser(world.tenantA.userId))
      .send({ name: "Renamed Hospital" })
      .expect(200);
    assertParse(UpdateFacilityResponse, res.body, "UpdateFacilityResponse");
  });

  it("GET /facilities/:id/signals", async () => {
    const res = await request(app)
      .get(`/facilities/${world.tenantA.facilityId}/signals`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetFacilitySignalsResponse, res.body, "GetFacilitySignalsResponse");
  });

  it("GET /facilities/:id/contacts", async () => {
    const res = await request(app)
      .get(`/facilities/${world.tenantA.facilityId}/contacts`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetFacilityContactsResponse, res.body, "GetFacilityContactsResponse");
  });

  it("GET /facilities/:id/equipment", async () => {
    const res = await request(app)
      .get(`/facilities/${world.tenantA.facilityId}/equipment`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetFacilityEquipmentResponse, res.body, "GetFacilityEquipmentResponse");
  });

  it("POST /contacts/:id/enrich (dryRun)", async () => {
    const res = await request(app)
      .post(`/contacts/${world.tenantA.contactId}/enrich`)
      .set(asUser(world.tenantA.userId))
      .send({ dryRun: true })
      .expect(200);
    assertParse(EnrichContactResponse, res.body, "EnrichContactResponse");
  });

  it("GET /campaigns", async () => {
    const res = await request(app)
      .get("/campaigns")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListCampaignsResponse, res.body, "ListCampaignsResponse");
  });

  it("POST /campaigns", async () => {
    const res = await request(app)
      .post("/campaigns")
      .set(asUser(world.tenantA.userId))
      .send({
        name: `contract campaign ${world.tag}`,
        subAccountId: world.tenantA.subAccountId,
      })
      .expect(201);
    assertParse(ListCampaignsResponseItem, res.body, "Created campaign item");
  });

  it("GET /campaigns/:id", async () => {
    const res = await request(app)
      .get(`/campaigns/${world.tenantA.campaignId}`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetCampaignResponse, res.body, "GetCampaignResponse");
  });

  it("PATCH /campaigns/:id", async () => {
    const res = await request(app)
      .patch(`/campaigns/${world.tenantA.campaignId}`)
      .set(asUser(world.tenantA.userId))
      .send({ description: "updated" })
      .expect(200);
    assertParse(UpdateCampaignResponse, res.body, "UpdateCampaignResponse");
  });

  it("GET /campaigns/:id/contacts", async () => {
    const res = await request(app)
      .get(`/campaigns/${world.tenantA.campaignId}/contacts`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListCampaignContactsResponse, res.body, "ListCampaignContactsResponse");
  });

  it("POST /campaigns/:id/contacts", async () => {
    const res = await request(app)
      .post(`/campaigns/${world.tenantA.campaignId}/contacts`)
      .set(asUser(world.tenantA.userId))
      .send({ contactIds: [world.tenantA.contactId] })
      .expect(201);
    assertParse(
      AddCampaignContactsResultSchema,
      res.body,
      "AddCampaignContactsResult",
    );
  });

  it("POST /campaigns/:id/generate-drafts", async () => {
    const res = await request(app)
      .post(`/campaigns/${world.tenantA.campaignId}/generate-drafts`)
      .set(asUser(world.tenantA.userId))
      .expect(202);
    assertParse(GenerateDraftsResultSchema, res.body, "GenerateDraftsResult");
  });

  it("GET /sequences", async () => {
    const res = await request(app)
      .get("/sequences")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListSequencesResponse, res.body, "ListSequencesResponse");
  });

  it("POST /sequences -> GET /sequences/:id -> POST /sequences/:id/steps", async () => {
    const created = await request(app)
      .post("/sequences")
      .set(asUser(world.tenantA.userId))
      .send({ name: `contract seq ${world.tag}`, channel: "email" })
      .expect(201);
    assertParse(ListSequencesResponseItem, created.body, "Created sequence item");
    const seqId = created.body.id;

    const got = await request(app)
      .get(`/sequences/${seqId}`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetSequenceResponse, got.body, "GetSequenceResponse");

    await request(app)
      .post(`/sequences/${seqId}/steps`)
      .set(asUser(world.tenantA.userId))
      .send({
        stepNum: 1,
        channel: "email",
        delayDays: 0,
        subjectLine: "hi",
        bodyTemplate: "Hello {{first_name}}",
      })
      .expect(201);
  });

  it("GET /drafts", async () => {
    const res = await request(app)
      .get("/drafts")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListDraftsResponse, res.body, "ListDraftsResponse");
  });

  it("GET /drafts/:id", async () => {
    const res = await request(app)
      .get(`/drafts/${world.tenantA.draftId}`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(GetDraftResponse, res.body, "GetDraftResponse");
  });

  it("PATCH /drafts/:id", async () => {
    const res = await request(app)
      .patch(`/drafts/${world.tenantA.draftId}`)
      .set(asUser(world.tenantA.userId))
      .send({ subject: "edited" })
      .expect(200);
    assertParse(UpdateDraftResponse, res.body, "UpdateDraftResponse");
  });

  it("POST /drafts/:id/reject", async () => {
    const res = await request(app)
      .post(`/drafts/${world.tenantA.draftId}/reject`)
      .set(asUser(world.tenantA.userId))
      .send({ reason: "test" })
      .expect(200);
    assertParse(RejectDraftResponse, res.body, "RejectDraftResponse");
  });

  it("POST /drafts/:id/approve", async () => {
    const res = await request(app)
      .post(`/drafts/${world.tenantA.draftId}/approve`)
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ApproveDraftResponse, res.body, "ApproveDraftResponse");
  });

  it("GET /batches", async () => {
    const res = await request(app)
      .get("/batches")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListBatchesResponse, res.body, "ListBatchesResponse");
  });

  it("POST /batches/run", async () => {
    const res = await request(app)
      .post("/batches/run")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(RunBatchesResponse, res.body, "RunBatchesResponse");
  });

  it("GET /reports/templates", async () => {
    const res = await request(app)
      .get("/reports/templates")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListReportTemplatesResponse, res.body, "ListReportTemplatesResponse");
  });

  it("POST /reports/templates", async () => {
    const res = await request(app)
      .post("/reports/templates")
      .set(asUser(world.tenantA.userId))
      .send({
        name: `contract tpl ${world.tag}`,
        dataSources: ["facilities"],
      })
      .expect(201);
    assertParse(
      ListReportTemplatesResponseItem,
      res.body,
      "Created report template item",
    );
  });

  it("POST /reports/run", async () => {
    const res = await request(app)
      .post("/reports/run")
      .set(asUser(world.tenantA.userId))
      .send({ templateId: world.tenantA.templateId })
      .expect(200);
    assertParse(RunReportResponse, res.body, "RunReportResponse");
  });

  it("GET /reports/runs", async () => {
    const res = await request(app)
      .get("/reports/runs")
      .set(asUser(world.tenantA.userId))
      .expect(200);
    assertParse(ListReportRunsResponse, res.body, "ListReportRunsResponse");
  });

  it("GET /admin/accounts", async () => {
    const res = await request(app)
      .get("/admin/accounts")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    assertParse(AdminListAccountsResponse, res.body, "AdminListAccountsResponse");
  });

  it("GET /admin/sub-accounts", async () => {
    const res = await request(app)
      .get("/admin/sub-accounts")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    assertParse(
      AdminListSubAccountsResponse,
      res.body,
      "AdminListSubAccountsResponse",
    );
  });

  it("GET /admin/users", async () => {
    const res = await request(app)
      .get("/admin/users")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    assertParse(AdminListUsersResponse, res.body, "AdminListUsersResponse");
  });

  it("GET /admin/enrichment-sources", async () => {
    const res = await request(app)
      .get("/admin/enrichment-sources")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    assertParse(
      AdminListEnrichmentSourcesResponse,
      res.body,
      "AdminListEnrichmentSourcesResponse",
    );
  });

  it("GET /admin/platform-stats", async () => {
    const res = await request(app)
      .get("/admin/platform-stats")
      .set(asUser(world.platformAdminUserId))
      .expect(200);
    assertParse(
      AdminPlatformStatsResponse,
      res.body,
      "AdminPlatformStatsResponse",
    );
  });
});
