import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, territories, type Territory, type InsertTerritory } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import {
  evaluateTerritory,
  territoryFilterSchema,
  type TerritoryFilter,
} from "../services/territoryService";
import { getEquipmentLineProfile } from "../services/equipmentLineService";
import { z } from "zod/v4";

const router: IRouter = Router();

const upsertBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  viewKind: z.enum(["buy_side", "sell_side"]).default("buy_side"),
  filter: territoryFilterSchema,
  equipmentLineSlug: z.string().nullable().optional(),
  isShared: z.boolean().optional(),
});

router.get("/territories", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const viewKind = typeof req.query.viewKind === "string" ? req.query.viewKind : undefined;

  const conds = [eq(territories.accountId, accountId)];
  if (viewKind === "buy_side" || viewKind === "sell_side") {
    conds.push(eq(territories.viewKind, viewKind));
  }
  const rows = await db
    .select()
    .from(territories)
    .where(and(...conds))
    .orderBy(desc(territories.updatedAt));
  res.json({ data: rows });
});

router.post("/territories", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const userId = req.currentUser?.id ?? null;
  const parsed = upsertBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const values: InsertTerritory = {
    accountId,
    viewKind: body.viewKind,
    name: body.name,
    description: body.description ?? null,
    filter: body.filter,
    equipmentLineSlug: body.equipmentLineSlug ?? null,
    isShared: body.isShared ?? false,
    createdBy: userId,
  };
  const [created] = await db.insert(territories).values(values).returning();
  res.status(201).json(created);
});

router.get("/territories/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [row] = await db
    .select()
    .from(territories)
    .where(and(eq(territories.id, id), eq(territories.accountId, accountId)));
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(row);
});

router.put("/territories/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const parsed = upsertBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const [updated] = await db
    .update(territories)
    .set({
      name: body.name,
      description: body.description ?? null,
      viewKind: body.viewKind,
      filter: body.filter,
      equipmentLineSlug: body.equipmentLineSlug ?? null,
      isShared: body.isShared ?? false,
      updatedAt: new Date(),
    })
    .where(and(eq(territories.id, id), eq(territories.accountId, accountId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

router.delete("/territories/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const result = await db
    .delete(territories)
    .where(and(eq(territories.id, id), eq(territories.accountId, accountId)))
    .returning({ id: territories.id });
  if (result.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(204).end();
});

/**
 * Evaluate a saved territory. Returns ranked TerritoryFacility[].
 * Sell-side mode auto-applies distress filters; equipment-line slug
 * (territory.equipmentLineSlug or override via ?equipmentLine=imaging)
 * re-scores results with the rubric.
 */
router.get("/territories/:id/facilities", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [row] = await db
    .select()
    .from(territories)
    .where(and(eq(territories.id, id), eq(territories.accountId, accountId)));
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Allow per-request overrides without persisting.
  const overrideSlug = typeof req.query.equipmentLine === "string" ? req.query.equipmentLine : null;
  const slug = overrideSlug ?? row.equipmentLineSlug;

  const baseFilter = row.filter as TerritoryFilter;
  // Honor the query-string limit/offset so the UI can paginate without
  // mutating the saved territory.
  if (typeof req.query.limit === "string") baseFilter.limit = Math.min(Number(req.query.limit) || 100, 500);
  if (typeof req.query.offset === "string") baseFilter.offset = Math.max(Number(req.query.offset) || 0, 0);
  if (typeof req.query.sortBy === "string") {
    const allowed = ["score_desc", "score_asc", "name", "beds_desc", "revenue_desc"] as const;
    if ((allowed as readonly string[]).includes(req.query.sortBy)) {
      baseFilter.sortBy = req.query.sortBy as TerritoryFilter["sortBy"];
    }
  }

  let rubric = undefined;
  if (slug) {
    const profile = await getEquipmentLineProfile(accountId, slug);
    if (profile) rubric = profile.rubric as import("../services/equipmentLineService").EquipmentLineRubric;
  }

  const out = await evaluateTerritory(baseFilter, {
    viewKind: row.viewKind === "sell_side" ? "sell_side" : "buy_side",
    rubric,
  });
  res.json(out);
});

/**
 * Preview — evaluate a filter without saving it. Useful for the planner UI's
 * "Apply" button.
 */
router.post("/territories/preview", requireAccount, async (req, res) => {
  const parsed = z
    .object({
      filter: territoryFilterSchema,
      viewKind: z.enum(["buy_side", "sell_side"]).default("buy_side"),
      equipmentLineSlug: z.string().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation", details: parsed.error.issues });
    return;
  }
  const { filter, viewKind, equipmentLineSlug } = parsed.data;
  let rubric = undefined;
  if (equipmentLineSlug) {
    const profile = await getEquipmentLineProfile(req.currentAccount!.id, equipmentLineSlug);
    if (profile) rubric = profile.rubric as import("../services/equipmentLineService").EquipmentLineRubric;
  }
  const out = await evaluateTerritory(filter, { viewKind, rubric });
  res.json(out);
});

// Silence to satisfy ts when the type isn't used elsewhere.
void ((_: Territory) => undefined);

export default router;
