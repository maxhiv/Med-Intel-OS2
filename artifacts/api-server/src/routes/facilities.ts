import { Router, type IRouter } from "express";
import {
  sql,
  eq,
  and,
  desc,
  ilike,
  gte,
  inArray,
  type SQL,
} from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  facilityContacts,
  equipmentRecords,
  accountFacilities,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { validateBody } from "../middlewares/validate";
import { syncFacilityFromNpi } from "../services/npiSync";
import { recomputeOne } from "../services/signalScorer";
import { CreateFacilityFromNpiBody, UpdateFacilityBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function assertAccountOwnsFacility(
  accountId: string,
  facilityId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: accountFacilities.id })
    .from(accountFacilities)
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        eq(accountFacilities.facilityId, facilityId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

router.get("/facilities", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const state = req.query.state as string | undefined;
  const facilityType = req.query.facilityType as string | undefined;
  const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
  const search = req.query.search as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const owned = await db
    .select({ id: accountFacilities.facilityId })
    .from(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  const facIds = owned.map((o) => o.id);

  if (facIds.length === 0) {
    res.json({ data: [], total: 0, limit, offset });
    return;
  }

  const conds: SQL[] = [inArray(facilities.id, facIds)];
  if (state) conds.push(eq(facilities.state, state));
  if (facilityType) conds.push(eq(facilities.facilityType, facilityType));
  if (typeof minScore === "number")
    conds.push(gte(facilities.signalScore, minScore));
  if (search) conds.push(ilike(facilities.name, `%${search}%`));
  const where = and(...conds);

  const rows = await db
    .select()
    .from(facilities)
    .where(where)
    .orderBy(desc(facilities.signalScore))
    .limit(limit)
    .offset(offset);

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(facilities)
    .where(where);

  res.json({ data: rows, total: c, limit, offset });
});

router.post("/facilities", requireAccount, validateBody(CreateFacilityFromNpiBody), async (req, res) => {
  const accountId = req.currentAccount!.id;
  const npi = String(req.body?.npi ?? "");
  if (npi.length !== 10) {
    res.status(400).json({ error: "npi_must_be_10_digits" });
    return;
  }
  let facility =
    (await db.select().from(facilities).where(eq(facilities.npi, npi)))[0];
  if (!facility) {
    const created = await syncFacilityFromNpi(npi);
    if (!created) {
      res.status(404).json({ error: "npi_not_found" });
      return;
    }
    facility = created;
  }
  // Auto-link to current account
  await db
    .insert(accountFacilities)
    .values({ accountId, facilityId: facility.id, status: "identified" })
    .onConflictDoNothing();
  res.status(201).json(facility);
});

router.get("/facilities/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  if (!(await assertAccountOwnsFacility(accountId, id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [f] = await db.select().from(facilities).where(eq(facilities.id, id));
  if (!f) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [signals, contacts, equipment] = await Promise.all([
    db
      .select()
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.facilityId, id),
          eq(purchaseSignals.isActive, true),
        ),
      )
      .orderBy(desc(purchaseSignals.detectedAt))
      .limit(50),
    db
      .select()
      .from(facilityContacts)
      .where(eq(facilityContacts.facilityId, id))
      .limit(200),
    db
      .select()
      .from(equipmentRecords)
      .where(eq(equipmentRecords.facilityId, id))
      .limit(200),
  ]);

  res.json({
    ...f,
    signals,
    contacts,
    equipment,
    activeSignalCount: signals.length,
    contactCount: contacts.length,
    equipmentCount: equipment.length,
  });
});

router.patch("/facilities/:id", requireAccount, validateBody(UpdateFacilityBody), async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  if (!(await assertAccountOwnsFacility(accountId, id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const allowed: Record<string, unknown> = {};
  for (const k of [
    "name",
    "facilityType",
    "city",
    "state",
    "beds",
    "website",
    "ownership",
  ]) {
    if (k in (req.body ?? {})) allowed[k] = req.body[k];
  }
  if (Object.keys(allowed).length === 0) {
    res.status(400).json({ error: "no_fields" });
    return;
  }
  allowed.updatedAt = new Date();
  const [updated] = await db
    .update(facilities)
    .set(allowed)
    .where(eq(facilities.id, id))
    .returning();
  res.json(updated);
});

router.get("/facilities/:id/signals", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  if (!(await assertAccountOwnsFacility(accountId, id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const rows = await db
    .select()
    .from(purchaseSignals)
    .where(eq(purchaseSignals.facilityId, id))
    .orderBy(desc(purchaseSignals.detectedAt));
  res.json(rows);
});

router.get("/facilities/:id/contacts", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  if (!(await assertAccountOwnsFacility(accountId, id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const rows = await db
    .select()
    .from(facilityContacts)
    .where(eq(facilityContacts.facilityId, id))
    .orderBy(desc(facilityContacts.confidenceScore));
  res.json(rows);
});

router.get("/facilities/:id/equipment", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  if (!(await assertAccountOwnsFacility(accountId, id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const rows = await db
    .select()
    .from(equipmentRecords)
    .where(eq(equipmentRecords.facilityId, id));
  res.json(rows);
});

router.post(
  "/facilities/sync-from-npi/:npi",
  requireAccount,
  async (req, res) => {
    const accountId = req.currentAccount!.id;
    const npi = String(req.params.npi);
    const f = await syncFacilityFromNpi(npi);
    if (!f) {
      res.status(404).json({ error: "npi_not_found" });
      return;
    }
    await db
      .insert(accountFacilities)
      .values({ accountId, facilityId: f.id, status: "identified" })
      .onConflictDoNothing();
    await recomputeOne(f.id);
    res.json(f);
  },
);

export default router;
