import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, facilityContacts, accountFacilities, facilities } from "@workspace/db";
import { requireAccount } from "../middlewares/auth";
import { validateBody } from "../middlewares/validate";
import { enrichContact } from "../services/enrichment";
import { EnrichContactBody } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * GET /contacts — returns all facility contacts for the current account.
 * Supports optional ?facilityId= filter and ?search= text filter.
 */
router.get("/contacts", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const facilityId = req.query.facilityId ? String(req.query.facilityId) : null;
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Number(req.query.offset ?? 0);

  // Build the base query: contacts whose facility belongs to this account.
  const rows = await db
    .select({
      id: facilityContacts.id,
      facilityId: facilityContacts.facilityId,
      facilityName: facilities.name,
      facilityState: facilities.state,
      firstName: facilityContacts.firstName,
      lastName: facilityContacts.lastName,
      title: facilityContacts.title,
      department: facilityContacts.department,
      email: facilityContacts.email,
      emailStatus: facilityContacts.emailStatus,
      phone: facilityContacts.phone,
      buyingAuthorityScore: facilityContacts.buyingAuthorityScore,
      createdAt: facilityContacts.createdAt,
    })
    .from(facilityContacts)
    .innerJoin(accountFacilities, and(
      eq(accountFacilities.facilityId, facilityContacts.facilityId),
      eq(accountFacilities.accountId, accountId),
    ))
    .innerJoin(facilities, eq(facilities.id, facilityContacts.facilityId))
    .where(facilityId ? eq(facilityContacts.facilityId, facilityId) : undefined)
    .orderBy(desc(facilityContacts.buyingAuthorityScore))
    .limit(limit)
    .offset(offset);

  res.json({ contacts: rows, total: rows.length, limit, offset });
});

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
