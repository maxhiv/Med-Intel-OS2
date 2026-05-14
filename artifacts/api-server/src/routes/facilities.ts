import { Router, type IRouter } from "express";
import {
  sql,
  eq,
  and,
  asc,
  desc,
  ilike,
  gte,
  inArray,
  isNotNull,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  facilityContacts,
  equipmentRecords,
  accountFacilities,
  contactValidationLog,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { validateBody } from "../middlewares/validate";
import { syncFacilityFromNpi } from "../services/npiSync";
import { recomputeOne, computeSignalBreakdown, type SignalBreakdown } from "../services/signalScorer";
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

/**
 * Batch-compute signal breakdowns for a list of facility IDs without
 * issuing N separate DB queries. Fetches all signals in one round trip,
 * then groups in memory.
 */
async function batchSignalBreakdowns(
  facilityIds: string[],
): Promise<Map<string, SignalBreakdown>> {
  if (facilityIds.length === 0) return new Map();

  const sigs = await db
    .select()
    .from(purchaseSignals)
    .where(
      and(
        inArray(purchaseSignals.facilityId, facilityIds),
        eq(purchaseSignals.isActive, true),
      ),
    );

  const TIER1 = new Set([
    "con_filed", "con_approved", "bond_issued", "rfp_posted", "hcris_depreciation_spike",
  ]);
  const TIER2 = new Set([
    "equipment_age_7yr", "high_utilization", "grant_awarded", "clinical_trial",
  ]);

  const WEIGHTS: Record<string, number> = {
    con_filed: 35, con_approved: 40, bond_issued: 35, rfp_posted: 40,
    hcris_depreciation_spike: 25, equipment_age_7yr: 20, high_utilization: 15,
    grant_awarded: 25, clinical_trial: 15, adverse_event_spike: 10, sec_capex_flag: 18,
    depreciation_flag: 12, eol_equipment: 12,
  };

  const grouped = new Map<string, typeof sigs>();
  for (const fid of facilityIds) grouped.set(fid, []);
  for (const s of sigs) {
    const arr = grouped.get(s.facilityId);
    if (arr) arr.push(s);
  }

  const result = new Map<string, SignalBreakdown>();
  for (const [fid, fsigs] of grouped) {
    const typeSet = new Set(fsigs.map((s) => s.signalType));
    let tier1Count = 0, tier2Count = 0, tier3Count = 0;
    for (const s of fsigs) {
      if (TIER1.has(s.signalType)) tier1Count++;
      else if (TIER2.has(s.signalType)) tier2Count++;
      else tier3Count++;
    }
    const crossSourceBonuses: string[] = [];
    if (typeSet.has("con_filed") && typeSet.has("bond_issued"))
      crossSourceBonuses.push("CON + Bond Match");
    if (typeSet.has("hcris_depreciation_spike") && typeSet.has("con_filed"))
      crossSourceBonuses.push("Depreciation + CON Match");
    if (typeSet.has("high_utilization") && typeSet.has("equipment_age_7yr"))
      crossSourceBonuses.push("High Utilization + Equipment Age");
    if (typeSet.has("rfp_posted") && fsigs.some((s) => s.source === "usa_spending"))
      crossSourceBonuses.push("RFP + Prior Award Match");

    const topSignals = fsigs
      .sort((a, b) => (WEIGHTS[b.signalType] ?? 0) - (WEIGHTS[a.signalType] ?? 0))
      .slice(0, 3)
      .map((s) => ({ type: s.signalType, detectedAt: s.detectedAt, confidence: s.confidence ?? 50 }));

    result.set(fid, { tier1Count, tier2Count, tier3Count, crossSourceBonuses, topSignals });
  }
  return result;
}

router.get("/facilities", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const state = req.query.state as string | undefined;
  const facilityType = req.query.facilityType as string | undefined;
  const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
  const search = req.query.search as string | undefined;
  const trackedOnly = req.query.trackedOnly === "true";
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const sortByParam = typeof req.query.sortBy === "string" ? req.query.sortBy.trim() : "score_desc";

  const conds: SQL[] = [];
  if (state) conds.push(eq(facilities.state, state));
  if (facilityType) conds.push(eq(facilities.facilityType, facilityType));
  if (typeof minScore === "number")
    conds.push(gte(facilities.signalScore, minScore));
  if (search) conds.push(ilike(facilities.name, `%${search}%`));
  if (trackedOnly) conds.push(isNotNull(accountFacilities.facilityId));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const orderClause =
    sortByParam === "score_asc"
      ? asc(facilities.signalScore)
      : sortByParam === "name"
      ? asc(facilities.name)
      : desc(facilities.signalScore);

  const rows = await db
    .select({
      ...getTableColumns(facilities),
      tracked: sql<boolean>`${accountFacilities.facilityId} IS NOT NULL`,
    })
    .from(facilities)
    .leftJoin(
      accountFacilities,
      and(
        eq(accountFacilities.facilityId, facilities.id),
        eq(accountFacilities.accountId, accountId),
      ),
    )
    .where(where)
    .orderBy(orderClause)
    .limit(limit)
    .offset(offset);

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(facilities)
    .leftJoin(
      accountFacilities,
      and(
        eq(accountFacilities.facilityId, facilities.id),
        eq(accountFacilities.accountId, accountId),
      ),
    )
    .where(where);

  const facilityIds = rows.map((r) => r.id);
  const breakdowns = await batchSignalBreakdowns(facilityIds);

  const data = rows.map((r) => ({
    ...r,
    signalBreakdown: breakdowns.get(r.id) ?? {
      tier1Count: 0,
      tier2Count: 0,
      tier3Count: 0,
      crossSourceBonuses: [],
      topSignals: [],
    },
  }));

  res.json({ data, total: c, limit, offset });
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
  const [signals, contacts, equipment, signalBreakdown] = await Promise.all([
    db
      .select()
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.facilityId, id),
          eq(purchaseSignals.isActive, true),
        ),
      )
      .orderBy(desc(purchaseSignals.detectedAt)),
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
    computeSignalBreakdown(id),
  ]);

  res.json({
    ...f,
    signals,
    contacts,
    equipment,
    signalBreakdown,
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

  const contactIds = rows.map((r) => r.id);
  const lastByContact = new Map<
    string,
    { source: string; result: string; checkedAt: Date }
  >();
  if (contactIds.length > 0) {
    const logs = await db
      .select({
        contactId: contactValidationLog.contactId,
        source: contactValidationLog.checkType,
        result: contactValidationLog.result,
        checkedAt: contactValidationLog.checkedAt,
      })
      .from(contactValidationLog)
      .where(
        and(
          inArray(contactValidationLog.contactId, contactIds),
          inArray(contactValidationLog.checkType, ["zerobounce", "bouncer"]),
        ),
      )
      .orderBy(desc(contactValidationLog.checkedAt));
    for (const l of logs) {
      if (!lastByContact.has(l.contactId) && l.checkedAt) {
        lastByContact.set(l.contactId, {
          source: l.source,
          result: l.result,
          checkedAt: l.checkedAt,
        });
      }
    }
  }

  res.json(
    rows.map((r) => ({
      ...r,
      lastValidation: lastByContact.get(r.id) ?? null,
    })),
  );
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

router.post("/facilities/:id/contacts", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const { firstName, lastName, title, department, email, phone } = req.body as {
    firstName?: string; lastName?: string; title?: string;
    department?: string; email?: string; phone?: string;
  };

  const [own] = await db
    .select({ id: accountFacilities.id })
    .from(accountFacilities)
    .where(and(eq(accountFacilities.accountId, accountId), eq(accountFacilities.facilityId, id)))
    .limit(1);
  if (!own) { res.status(403).json({ error: "forbidden" }); return; }

  const [contact] = await db
    .insert(facilityContacts)
    .values({
      facilityId: id,
      firstName: firstName?.trim() || null,
      lastName: lastName?.trim() || null,
      title: title?.trim() || null,
      department: department?.trim() || null,
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      confidenceScore: 0,
    })
    .returning();
  res.status(201).json(contact);
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
