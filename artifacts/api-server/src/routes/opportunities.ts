import { Router, type IRouter } from "express";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  opportunities,
  opportunityActions,
  facilities,
  facilityContacts,
  purchaseSignals,
  type Opportunity,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { generateOpportunities } from "../services/opportunity/opportunityGenerator";

const router: IRouter = Router();

// ─── List opportunities for the current account ─────────────────────────────
router.get("/opportunities", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const ALLOWED_STATUSES = [
    "detected", "rep_reviewed", "qualified", "bid_submitted", "won", "lost", "dormant",
  ] as const;
  const conds = [eq(opportunities.accountId, accountId)];
  if (statusParam && (ALLOWED_STATUSES as readonly string[]).includes(statusParam)) {
    conds.push(eq(opportunities.status, statusParam as Opportunity["status"]));
  } else {
    // Default: hide dormant + lost from the inbox.
    conds.push(
      inArray(opportunities.status, ["detected", "rep_reviewed", "qualified", "bid_submitted", "won"] as const),
    );
  }

  const rows = await db
    .select({
      ...getTableColumns(opportunities),
      facility_id_join: facilities.id,
      facility_name: facilities.name,
      facility_type: facilities.facilityType,
      facility_city: facilities.city,
      facility_state: facilities.state,
      facility_beds: facilities.beds,
      facility_npi: facilities.npi,
    })
    .from(opportunities)
    .innerJoin(facilities, eq(facilities.id, opportunities.facilityId))
    .where(and(...conds))
    .orderBy(desc(opportunities.readinessScore), desc(opportunities.detectedAt))
    .limit(limit)
    .offset(offset);

  const reshaped = rows.map((r) => {
    const {
      facility_id_join: _fid,
      facility_name,
      facility_type,
      facility_city,
      facility_state,
      facility_beds,
      facility_npi,
      ...opp
    } = r;
    return {
      ...opp,
      facility: {
        id: opp.facilityId,
        name: facility_name,
        facilityType: facility_type,
        city: facility_city,
        state: facility_state,
        beds: facility_beds,
        npi: facility_npi,
      },
    };
  });

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(and(...conds));

  res.json({ data: reshaped, total: c, limit, offset });
});

// ─── Single opportunity detail ──────────────────────────────────────────────
router.get("/opportunities/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);

  const [opp] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, id), eq(opportunities.accountId, accountId)));
  if (!opp) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const [facility] = await db
    .select()
    .from(facilities)
    .where(eq(facilities.id, opp.facilityId))
    .limit(1);

  const triggers =
    opp.topTriggerIds && opp.topTriggerIds.length > 0
      ? await db
          .select()
          .from(purchaseSignals)
          .where(inArray(purchaseSignals.id, opp.topTriggerIds))
      : [];

  const contactIds = [opp.championContactId, opp.economicBuyerContactId, opp.gatekeeperContactId]
    .filter((id): id is string => Boolean(id));
  const contacts =
    contactIds.length > 0
      ? await db
          .select()
          .from(facilityContacts)
          .where(inArray(facilityContacts.id, contactIds))
      : [];
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const actions = await db
    .select()
    .from(opportunityActions)
    .where(eq(opportunityActions.opportunityId, opp.id))
    .orderBy(desc(opportunityActions.performedAt))
    .limit(50);

  res.json({
    ...opp,
    facility,
    triggers,
    decisionMakers: {
      champion: opp.championContactId ? contactById.get(opp.championContactId) ?? null : null,
      economicBuyer: opp.economicBuyerContactId ? contactById.get(opp.economicBuyerContactId) ?? null : null,
      gatekeeper: opp.gatekeeperContactId ? contactById.get(opp.gatekeeperContactId) ?? null : null,
    },
    actions,
  });
});

// ─── Record a rep action ────────────────────────────────────────────────────
const actionBodySchema = z.object({
  actionType: z.enum([
    "pursue", "skip", "snooze", "note", "push_to_ghl", "qualify", "disqualify", "won", "lost",
  ]),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  snoozeDays: z.number().int().positive().max(180).optional(),
});

router.post("/opportunities/:id/actions", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const userId = req.currentUser?.id ?? null;
  const id = String(req.params.id);

  const parsed = actionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  const [opp] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, id), eq(opportunities.accountId, accountId)));
  if (!opp) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Log the action first so the audit trail records even refused state changes.
  await db.insert(opportunityActions).values({
    opportunityId: opp.id,
    actionType: body.actionType,
    performedBy: userId,
    notes: body.notes ?? null,
    metadata: body.metadata ?? {},
  });

  // Apply state transitions per action.
  const update: Partial<typeof opportunities.$inferInsert> = { updatedAt: new Date() };
  switch (body.actionType) {
    case "pursue":
      update.status = "qualified";
      update.repReviewedAt = new Date();
      if (userId) update.repAssignedTo = userId;
      break;
    case "qualify":
      update.status = "qualified";
      update.repReviewedAt = new Date();
      break;
    case "disqualify":
    case "skip":
      update.status = "dormant";
      update.repReviewedAt = new Date();
      break;
    case "snooze": {
      const days = body.snoozeDays ?? 14;
      const until = new Date();
      until.setDate(until.getDate() + days);
      update.snoozedUntil = until;
      break;
    }
    case "push_to_ghl":
      update.status = "bid_submitted";
      update.crmPushedAt = new Date();
      break;
    case "won":
      update.status = "won";
      break;
    case "lost":
      update.status = "lost";
      break;
    case "note":
      if (body.notes) update.notes = body.notes;
      break;
  }

  if (Object.keys(update).length > 1) {
    await db.update(opportunities).set(update).where(eq(opportunities.id, opp.id));
  }

  const [refreshed] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, opp.id));
  res.json(refreshed);
});

// ─── Manual regeneration (rep-triggered) ────────────────────────────────────
// Useful when a rep wants to force a fresh inbox after loading new data.
router.post("/opportunities/regenerate", requireAccount, async (_req, res) => {
  const result = await generateOpportunities({ facilityLimit: 5000 });
  res.json(result);
});

export default router;
