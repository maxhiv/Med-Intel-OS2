import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, equipmentLineProfiles } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import {
  equipmentLineRubricSchema,
  listEquipmentLineProfilesForAccount,
  getEquipmentLineProfile,
} from "../services/equipmentLineService";
import { z } from "zod/v4";

const router: IRouter = Router();

router.get("/equipment-lines", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const rows = await listEquipmentLineProfilesForAccount(accountId);
  res.json({ data: rows });
});

router.get("/equipment-lines/:slug", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const slug = String(req.params.slug);
  const profile = await getEquipmentLineProfile(accountId, slug);
  if (!profile) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(profile);
});

const upsertSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  rubric: equipmentLineRubricSchema,
});

/**
 * Create or update an account-scoped customization of a system slug. Per
 * brief, account admins can tune the weights without redeploying.
 */
router.put("/equipment-lines/:slug", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const slug = String(req.params.slug);
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const existing = await db
    .select()
    .from(equipmentLineProfiles)
    .where(and(eq(equipmentLineProfiles.accountId, accountId), eq(equipmentLineProfiles.slug, slug)))
    .limit(1);
  if (existing[0]) {
    const [updated] = await db
      .update(equipmentLineProfiles)
      .set({ name: body.name, description: body.description ?? null, rubric: body.rubric, updatedAt: new Date() })
      .where(eq(equipmentLineProfiles.id, existing[0].id))
      .returning();
    res.json(updated);
    return;
  }
  const [created] = await db
    .insert(equipmentLineProfiles)
    .values({
      slug,
      name: body.name,
      description: body.description ?? null,
      rubric: body.rubric,
      accountId,
      isSystem: false,
    })
    .returning();
  res.status(201).json(created);
});

router.delete("/equipment-lines/:slug", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const slug = String(req.params.slug);
  const result = await db
    .delete(equipmentLineProfiles)
    .where(
      and(
        eq(equipmentLineProfiles.accountId, accountId),
        eq(equipmentLineProfiles.slug, slug),
        eq(equipmentLineProfiles.isSystem, false),
      ),
    )
    .returning({ id: equipmentLineProfiles.id });
  if (result.length === 0) {
    res.status(404).json({ error: "not_found_or_system" });
    return;
  }
  res.status(204).end();
});

export default router;
