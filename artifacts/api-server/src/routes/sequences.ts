import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, sequences, sequenceSteps } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/sequences", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const rows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.accountId, accountId))
    .orderBy(desc(sequences.createdAt));
  res.json(rows);
});

router.post("/sequences", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const { name, description, channel } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }
  const [created] = await db
    .insert(sequences)
    .values({
      accountId,
      name,
      description: description ?? null,
      channel: channel ?? "email",
      createdBy: req.currentUser?.id ?? null,
    })
    .returning();
  res.status(201).json(created);
});

router.get("/sequences/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [s] = await db
    .select()
    .from(sequences)
    .where(and(eq(sequences.id, id), eq(sequences.accountId, accountId)));
  if (!s) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const steps = await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, id))
    .orderBy(sequenceSteps.stepNum);
  res.json({ ...s, steps });
});

router.post("/sequences/:id/steps", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const sequenceId = String(req.params.id);
  const [s] = await db
    .select()
    .from(sequences)
    .where(
      and(eq(sequences.id, sequenceId), eq(sequences.accountId, accountId)),
    );
  if (!s) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { subjectLine, bodyTemplate, delayDays, channel, variant } =
    req.body ?? {};
  const [{ next }] = await db
    .select({
      next: sql<number>`COALESCE(MAX(step_num), 0) + 1`,
    })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId));
  const [created] = await db
    .insert(sequenceSteps)
    .values({
      sequenceId,
      stepNum: next,
      channel: channel ?? "email",
      delayDays: delayDays ?? 0,
      subjectLine: subjectLine ?? null,
      bodyTemplate: bodyTemplate ?? null,
      variant: variant ?? "A",
    })
    .returning();
  await db
    .update(sequences)
    .set({ totalSteps: next, updatedAt: new Date() })
    .where(eq(sequences.id, sequenceId));
  res.status(201).json(created);
});

export default router;
