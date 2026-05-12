import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, facilityContacts, accountFacilities } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { validateBody } from "../middlewares/validate";
import { enrichContact } from "../services/enrichment";
import { EnrichContactBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/contacts/:id/enrich", requireAccount, validateBody(EnrichContactBody), async (req, res) => {
  const accountId = req.currentAccount!.id;
  const id = String(req.params.id);
  const dryRun = Boolean(req.body?.dryRun);

  // Verify the contact belongs to a facility owned by this account
  const [c] = await db
    .select({ facilityId: facilityContacts.facilityId })
    .from(facilityContacts)
    .where(eq(facilityContacts.id, id))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "contact_not_found" });
    return;
  }
  const [own] = await db
    .select({ id: accountFacilities.id })
    .from(accountFacilities)
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        eq(accountFacilities.facilityId, c.facilityId),
      ),
    )
    .limit(1);
  if (!own) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const result = await enrichContact(id, { dryRun });
  res.json(result);
});

export default router;
