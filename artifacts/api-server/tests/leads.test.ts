/**
 * Integration tests for GET /leads and related helpers (task #83).
 *
 * Covers:
 *  - tierFilter A / B / C scopes results to the correct score range
 *  - minScore param excludes facilities below the threshold
 *  - tierFilter=A returns only score >= 70 facilities (dashboard widget contract)
 *  - crossSourceMatches labels match the CROSS_SOURCE_BONUS_RULES matrix
 *
 * The test suite ensures the `app_rls` role exists before running so that the
 * RLS transaction middleware can engage. This role is normally created by the
 * db seed script; if it is absent (fresh test database) this beforeAll creates it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  pool,
  accounts,
  users,
  facilities,
  accountFacilities,
  purchaseSignals,
  facilityContacts,
} from "@workspace/db";
import { CROSS_SOURCE_BONUS_RULES } from "../src/services/signalScorer";
import { createTestApp } from "./helpers/testApp";

const app = createTestApp();

// ─── fixtures ────────────────────────────────────────────────────────────────

let accountId: string;
let userId: string;
let facIdA: string;   // score 75 → tier A
let facIdB: string;   // score 55 → tier B
let facIdC: string;   // score 45 → tier C
let facIdCrossA: string; // tier A facility with cross-source signals

const cleanupFacilityIds: string[] = [];
const cleanupSignalIds: string[] = [];

function asUser() {
  return { "x-test-user-id": userId };
}

// ─── one-time RLS role setup ──────────────────────────────────────────────────

/**
 * Ensure the `app_rls` Postgres role exists and has the grants the RLS
 * transaction middleware needs. This is idempotent — safe to run even when the
 * role was already created by the db seed script.
 */
async function ensureAppRlsRole(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
          CREATE ROLE app_rls NOLOGIN NOSUPERUSER NOBYPASSRLS;
        ELSE
          ALTER ROLE app_rls NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO app_rls`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls`,
    );
    await client.query(`GRANT app_rls TO CURRENT_USER`);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await ensureAppRlsRole();

  // Create a dedicated test account + user so we don't pollute the shared world.
  const [acct] = await db
    .insert(accounts)
    .values({
      name: "Leads Test Account",
      slug: `leads-test-${Date.now()}`,
      planTier: "starter",
      defaultCrm: "ghl",
      status: "active",
    })
    .returning();
  accountId = acct.id;

  const [usr] = await db
    .insert(users)
    .values({
      email: `leads-test-${Date.now()}@example.test`,
      role: "rep",
      accountId: acct.id,
      firstName: "Leads",
      lastName: "Tester",
    })
    .returning();
  userId = usr.id;

  async function insertFac(name: string, score: number): Promise<string> {
    const npi = String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
    const [fac] = await db
      .insert(facilities)
      .values({ npi, name, facilityType: "hospital", state: "TX", city: "Austin", signalScore: score })
      .returning();
    await db.insert(accountFacilities).values({
      accountId,
      facilityId: fac.id,
      status: "identified",
    });
    cleanupFacilityIds.push(fac.id);
    return fac.id;
  }

  facIdA = await insertFac("Alpha Hospital", 75);
  facIdB = await insertFac("Beta Clinic", 55);
  facIdC = await insertFac("Gamma Center", 45);
  facIdCrossA = await insertFac("Delta System", 80);

  // Seed cross-source signals: con_approved + bond_issued → "CON Approved + Capital Confirmed"
  const sigs = await db
    .insert(purchaseSignals)
    .values([
      {
        facilityId: facIdCrossA,
        signalType: "con_approved",
        source: "cms",
        confidence: 90,
        isActive: true,
      },
      {
        facilityId: facIdCrossA,
        signalType: "bond_issued",
        source: "sec",
        confidence: 85,
        isActive: true,
      },
    ])
    .returning();
  cleanupSignalIds.push(...sigs.map((s) => s.id));
});

afterAll(async () => {
  if (cleanupSignalIds.length > 0) {
    await db.delete(purchaseSignals).where(inArray(purchaseSignals.id, cleanupSignalIds));
  }
  const contactRows = await db
    .select({ id: facilityContacts.id })
    .from(facilityContacts)
    .where(inArray(facilityContacts.facilityId, cleanupFacilityIds));
  if (contactRows.length > 0) {
    await db
      .delete(facilityContacts)
      .where(inArray(facilityContacts.id, contactRows.map((r) => r.id)));
  }
  await db
    .delete(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  if (cleanupFacilityIds.length > 0) {
    await db.delete(facilities).where(inArray(facilities.id, cleanupFacilityIds));
  }
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

// ─── GET /leads — tier filter ─────────────────────────────────────────────────

describe("GET /leads — tier filter", () => {
  it("tierFilter=A returns only facilities with score >= 70", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=A&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as { leads: Array<{ score: number; tier: string }> };
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(70);
      expect(lead.tier).toBe("A");
    }
    const ids = (res.body.leads as Array<{ facilityId: string }>).map((l) => l.facilityId);
    expect(ids).toContain(facIdA);
    expect(ids).toContain(facIdCrossA);
    expect(ids).not.toContain(facIdB);
    expect(ids).not.toContain(facIdC);
  });

  it("tierFilter=B returns only facilities with 50 <= score < 70", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=B&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as { leads: Array<{ score: number; tier: string }> };
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(50);
      expect(lead.score).toBeLessThan(70);
      expect(lead.tier).toBe("B");
    }
    const ids = (res.body.leads as Array<{ facilityId: string }>).map((l) => l.facilityId);
    expect(ids).toContain(facIdB);
    expect(ids).not.toContain(facIdA);
    expect(ids).not.toContain(facIdC);
  });

  it("tierFilter=C returns only facilities with 40 <= score < 50", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=C&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as { leads: Array<{ score: number; tier: string }> };
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(40);
      expect(lead.score).toBeLessThan(50);
      expect(lead.tier).toBe("C");
    }
    const ids = (res.body.leads as Array<{ facilityId: string }>).map((l) => l.facilityId);
    expect(ids).toContain(facIdC);
    expect(ids).not.toContain(facIdA);
    expect(ids).not.toContain(facIdB);
  });

  it("no tierFilter returns all tiers above default minScore=40", async () => {
    const res = await request(app)
      .get("/leads?limit=100")
      .set(asUser())
      .expect(200);

    const ids = (res.body.leads as Array<{ facilityId: string }>).map((l) => l.facilityId);
    expect(ids).toContain(facIdA);
    expect(ids).toContain(facIdB);
    expect(ids).toContain(facIdC);
  });
});

// ─── GET /leads — minScore ────────────────────────────────────────────────────

describe("GET /leads — minScore param", () => {
  it("minScore=60 excludes facilities with score < 60", async () => {
    const res = await request(app)
      .get("/leads?minScore=60&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as { leads: Array<{ score: number }> };
    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(60);
    }
    const ids = (res.body.leads as Array<{ facilityId: string }>).map((l) => l.facilityId);
    expect(ids).toContain(facIdA);
    expect(ids).toContain(facIdCrossA);
    expect(ids).not.toContain(facIdB);
    expect(ids).not.toContain(facIdC);
  });

  it("minScore=70 combined with tierFilter=A still enforces >=70", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=A&minScore=70&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as { leads: Array<{ score: number; tier: string }> };
    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(70);
      expect(lead.tier).toBe("A");
    }
  });

  it("minScore higher than tierFilter floor overrides tier lower bound", async () => {
    // tierFilter=B floor is 50, but minScore=65 should exclude score-55 facility.
    const res = await request(app)
      .get("/leads?tierFilter=B&minScore=65&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as { leads: Array<{ score: number }> };
    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(65);
      expect(lead.score).toBeLessThan(70);
    }
    const ids = (res.body.leads as Array<{ facilityId: string }>).map((l) => l.facilityId);
    expect(ids).not.toContain(facIdB);
  });
});

// ─── GET /leads — dashboard widget contract ───────────────────────────────────

describe("GET /leads — dashboard widget contract (tierFilter=A)", () => {
  it("tierFilter=A returns only score >= 70 facilities", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=A&limit=50")
      .set(asUser())
      .expect(200);

    const { leads, total } = res.body as {
      leads: Array<{ score: number; tier: string; facilityId: string }>;
      total: number;
    };

    for (const lead of leads) {
      expect(lead.score).toBeGreaterThanOrEqual(70);
      expect(lead.tier).toBe("A");
    }
    expect(total).toBeGreaterThanOrEqual(leads.length);
  });
});

// ─── GET /leads — crossSourceMatches labels ───────────────────────────────────

describe("GET /leads — crossSourceMatches labels", () => {
  it("labels in the response are a subset of CROSS_SOURCE_BONUS_RULES labels", async () => {
    const validLabels = new Set(CROSS_SOURCE_BONUS_RULES.map((r) => r.label));

    const res = await request(app)
      .get("/leads?tierFilter=A&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as {
      leads: Array<{ crossSourceMatches: string[] }>;
    };

    for (const lead of leads) {
      for (const label of lead.crossSourceMatches) {
        expect(validLabels.has(label)).toBe(true);
      }
    }
  });

  it("facility with con_approved + bond_issued gets 'CON Approved + Capital Confirmed'", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=A&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as {
      leads: Array<{ facilityId: string; crossSourceMatches: string[] }>;
    };

    const crossFac = leads.find((l) => l.facilityId === facIdCrossA);
    expect(crossFac).toBeDefined();
    expect(crossFac!.crossSourceMatches).toContain("CON Approved + Capital Confirmed");
  });

  it("facilities without cross-source signal combos have an empty crossSourceMatches array", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=A&limit=100")
      .set(asUser())
      .expect(200);

    const { leads } = res.body as {
      leads: Array<{ facilityId: string; crossSourceMatches: string[] }>;
    };

    // facIdA (score 75) has no signals seeded — crossSourceMatches must be [].
    const plainFac = leads.find((l) => l.facilityId === facIdA);
    expect(plainFac).toBeDefined();
    expect(plainFac!.crossSourceMatches).toEqual([]);
  });
});

// ─── GET /leads — response shape ─────────────────────────────────────────────

describe("GET /leads — response shape", () => {
  it("returns the expected top-level fields and fye sub-object", async () => {
    const res = await request(app)
      .get("/leads?tierFilter=A&limit=1")
      .set(asUser())
      .expect(200);

    const { leads, total, offset, limit } = res.body as {
      leads: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
    };

    expect(typeof total).toBe("number");
    expect(typeof offset).toBe("number");
    expect(typeof limit).toBe("number");

    if (leads.length > 0) {
      const lead = leads[0];
      expect(lead).toHaveProperty("facilityId");
      expect(lead).toHaveProperty("score");
      expect(lead).toHaveProperty("tier");
      expect(lead).toHaveProperty("recommendedAction");
      expect(lead).toHaveProperty("urgency");
      expect(lead).toHaveProperty("topSignals");
      expect(lead).toHaveProperty("crossSourceMatches");
      expect(lead).toHaveProperty("contacts");
      expect(lead).toHaveProperty("fye");

      const fye = lead.fye as Record<string, unknown>;
      expect(fye).toHaveProperty("daysUntil");
      expect(fye).toHaveProperty("timingBonus");
      expect(fye).toHaveProperty("budgetWindowStatus");
    }
  });

  it("returns 401 without auth", async () => {
    await request(app).get("/leads").expect(401);
  });
});
