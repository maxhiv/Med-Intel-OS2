import { Router, type IRouter } from "express";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import {
  db,
  campaigns,
  campaignContacts,
  facilityContacts,
  facilities,
  subAccounts,
  accountFacilities,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { validateBody } from "../middlewares/validate";
import { generateDraftsForCampaign } from "../services/draftGenerator";
import { CreateCampaignBody, UpdateCampaignBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/campaigns", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.accountId, accountId))
    .orderBy(desc(campaigns.createdAt));
  res.json(rows);
});

router.post("/campaigns", requireAccount, validateBody(CreateCampaignBody), async (req, res) => {
  const accountId = req.currentAccount!.id;
  const { name, description, subAccountId, batchSizeDaily, filterCriteria } =
    req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }

  let resolvedSubId = subAccountId as string | undefined;
  if (resolvedSubId) {
    // Verify sub-account belongs to current account
    const [own] = await db
      .select({ id: subAccounts.id })
      .from(subAccounts)
      .where(
        and(
          eq(subAccounts.id, resolvedSubId),
          eq(subAccounts.accountId, accountId),
        ),
      )
      .limit(1);
    if (!own) {
      res.status(403).json({ error: "sub_account_not_owned" });
      return;
    }
  } else {
    const [sub] = await db
      .select({ id: subAccounts.id })
      .from(subAccounts)
      .where(eq(subAccounts.accountId, accountId))
      .limit(1);
    if (!sub) {
      const [created] = await db
        .insert(subAccounts)
        .values({ accountId, name: "Default", crmType: "ghl" })
        .returning({ id: subAccounts.id });
      resolvedSubId = created.id;
    } else {
      resolvedSubId = sub.id;
    }
  }

  const [created] = await db
    .insert(campaigns)
    .values({
      accountId,
      subAccountId: resolvedSubId,
      name,
      description: description ?? null,
      filterCriteria: filterCriteria ?? {},
      batchSizeDaily: batchSizeDaily ?? 10,
      status: "draft",
    })
    .returning();
  res.status(201).json(created);
});

router.get("/campaigns/:id", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const [c] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)));
  if (!c) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [{ ct }] = await db
    .select({ ct: sql<number>`count(*)::int` })
    .from(campaignContacts)
    .where(eq(campaignContacts.campaignId, id));
  res.json({ ...c, contactCount: ct });
});

router.patch("/campaigns/:id", requireAccount, validateBody(UpdateCampaignBody), async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const allowed: Record<string, unknown> = {};
  for (const k of [
    "name",
    "description",
    "status",
    "batchSizeDaily",
    "filterCriteria",
  ]) {
    if (k in (req.body ?? {})) allowed[k] = req.body[k];
  }
  allowed.updatedAt = new Date();
  const [updated] = await db
    .update(campaigns)
    .set(allowed)
    .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

router.get("/campaigns/:id/contacts", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const rows = await db
    .select({
      cc: campaignContacts,
      contact: facilityContacts,
      facility: facilities,
    })
    .from(campaignContacts)
    .innerJoin(
      facilityContacts,
      eq(facilityContacts.id, campaignContacts.contactId),
    )
    .innerJoin(facilities, eq(facilities.id, facilityContacts.facilityId))
    .where(
      and(
        eq(campaignContacts.campaignId, id),
        eq(campaignContacts.accountId, accountId),
      ),
    )
    .orderBy(desc(campaignContacts.score));

  // Reshape to match the OpenAPI CampaignContact schema (nested contact/facility)
  res.json(
    rows.map((r) => ({
      id: r.cc.id,
      campaignId: r.cc.campaignId,
      contactId: r.cc.contactId,
      status: r.cc.status,
      score: r.cc.score,
      enrolledAt: r.cc.enrolledAt,
      contact: r.contact,
      facility: r.facility,
    })),
  );
});

router.post("/campaigns/:id/contacts", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const contactIds: string[] = Array.isArray(req.body?.contactIds)
    ? req.body.contactIds.filter((x: unknown) => typeof x === "string")
    : [];
  if (contactIds.length === 0) {
    res.status(400).json({ error: "contactIds_required" });
    return;
  }

  // 1. Verify the campaign belongs to the caller's account
  const [own] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
    .limit(1);
  if (!own) {
    res.status(404).json({ error: "campaign_not_found" });
    return;
  }

  // 2. Verify every contact maps to a facility owned by this account
  const ownedRows = await db
    .select({ contactId: facilityContacts.id })
    .from(facilityContacts)
    .innerJoin(
      accountFacilities,
      eq(accountFacilities.facilityId, facilityContacts.facilityId),
    )
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        inArray(facilityContacts.id, contactIds),
      ),
    );
  const ownedSet = new Set(ownedRows.map((r) => r.contactId));
  const allowed = contactIds.filter((cid) => ownedSet.has(cid));
  const rejected = contactIds.length - allowed.length;
  if (allowed.length === 0) {
    res.status(403).json({ error: "no_owned_contacts" });
    return;
  }

  let added = 0;
  for (const cid of allowed) {
    try {
      await db.insert(campaignContacts).values({
        campaignId: id,
        accountId,
        contactId: cid,
        status: "queued",
        enrolledAt: new Date(),
      });
      added += 1;
    } catch {
      // Unique conflict — already enrolled
    }
  }
  res
    .status(201)
    .json({ added, requested: contactIds.length, rejectedCrossTenant: rejected });
});

router.post(
  "/campaigns/:id/generate-drafts",
  requireAccount,
  async (req, res) => {
    const accountId = req.currentAccount!.id;
    const id = String(req.params.id);
    try {
      const result = await generateDraftsForCampaign(id, accountId);
      res.status(202).json(result);
    } catch (e) {
      if (e instanceof Error && e.message === "campaign_not_found") {
        res.status(404).json({ error: "campaign_not_found" });
        return;
      }
      throw e;
    }
  },
);

export default router;
