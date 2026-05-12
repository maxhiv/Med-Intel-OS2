import { Router, type IRouter } from "express";
import { sql, desc, eq, and, inArray } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  outreachDrafts,
  campaigns,
  facilityContacts,
  accountFacilities,
  syncBatches,
} from "@workspace/db";
import { requireAccount } from "../middlewares/auth";

const router: IRouter = Router();

async function tenantFacilityIds(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ id: accountFacilities.facilityId })
    .from(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  return rows.map((r) => r.id);
}

router.get("/dashboard/summary", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const facIds = await tenantFacilityIds(accountId);

  let totalFacilities = 0;
  let totalContacts = 0;
  let verifiedContacts = 0;
  let activeSignals = 0;
  let avgScore = 0;
  let signalsByType: { signalType: string; count: number }[] = [];

  if (facIds.length > 0) {
    const [fc] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilities)
      .where(inArray(facilities.id, facIds));
    totalFacilities = fc.c;

    const [tc] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilityContacts)
      .where(inArray(facilityContacts.facilityId, facIds));
    totalContacts = tc.c;

    const [vc] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(facilityContacts)
      .where(
        and(
          inArray(facilityContacts.facilityId, facIds),
          eq(facilityContacts.humanVerified, true),
        ),
      );
    verifiedContacts = vc.c;

    const [as_] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(purchaseSignals)
      .where(
        and(
          inArray(purchaseSignals.facilityId, facIds),
          eq(purchaseSignals.isActive, true),
        ),
      );
    activeSignals = as_.c;

    const [avg] = await db
      .select({ a: sql<number>`COALESCE(AVG(signal_score), 0)::float` })
      .from(facilities)
      .where(inArray(facilities.id, facIds));
    avgScore = avg.a;

    signalsByType = await db
      .select({
        signalType: sql<string>`signal_type::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(purchaseSignals)
      .where(
        and(
          inArray(purchaseSignals.facilityId, facIds),
          eq(purchaseSignals.isActive, true),
        ),
      )
      .groupBy(purchaseSignals.signalType);
  }

  const [pendingDrafts] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.accountId, accountId),
        eq(outreachDrafts.status, "pending"),
      ),
    );
  const [approvedDrafts] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.accountId, accountId),
        eq(outreachDrafts.status, "approved"),
      ),
    );
  const [myCampaigns] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(eq(campaigns.accountId, accountId));

  const today = new Date().toISOString().slice(0, 10);
  const [batchesToday] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(syncBatches)
    .where(
      and(
        eq(syncBatches.accountId, accountId),
        eq(syncBatches.batchDate, today),
      ),
    );

  res.json({
    totalFacilities,
    totalContacts,
    verifiedContacts,
    activeSignals,
    pendingDrafts: pendingDrafts.c,
    approvedDrafts: approvedDrafts.c,
    batchesToday: batchesToday.c,
    myCampaigns: myCampaigns.c,
    avgSignalScore: Number(avgScore.toFixed(1)),
    signalsByType,
  });
});

router.get("/dashboard/recent-signals", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const facIds = await tenantFacilityIds(accountId);
  if (facIds.length === 0) {
    res.json([]);
    return;
  }
  const rows = await db
    .select({
      id: purchaseSignals.id,
      facilityId: purchaseSignals.facilityId,
      facilityName: facilities.name,
      facilityState: facilities.state,
      signalType: purchaseSignals.signalType,
      signalValue: purchaseSignals.signalValue,
      confidence: purchaseSignals.confidence,
      source: purchaseSignals.source,
      detectedAt: purchaseSignals.detectedAt,
      isActive: purchaseSignals.isActive,
    })
    .from(purchaseSignals)
    .innerJoin(facilities, eq(facilities.id, purchaseSignals.facilityId))
    .where(
      and(
        eq(purchaseSignals.isActive, true),
        inArray(purchaseSignals.facilityId, facIds),
      ),
    )
    .orderBy(desc(purchaseSignals.detectedAt))
    .limit(limit);
  res.json(rows);
});

router.get("/dashboard/top-facilities", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const facIds = await tenantFacilityIds(accountId);
  if (facIds.length === 0) {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(facilities)
    .where(inArray(facilities.id, facIds))
    .orderBy(desc(facilities.signalScore))
    .limit(limit);
  res.json(rows);
});

export default router;
