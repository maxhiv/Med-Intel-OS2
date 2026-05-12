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

  // Engagement aggregates over the last 30 days. `sentCount` is anything that
  // left the platform (synced to a CRM); the rates are computed off that base
  // so they reflect actual deliverability rather than total drafts generated.
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [eng] = await db
    .select({
      sent: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.crmSyncedAt} IS NOT NULL AND ${outreachDrafts.crmSyncedAt} >= ${since30})::int`,
      opened: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.openedAt} IS NOT NULL AND ${outreachDrafts.openedAt} >= ${since30})::int`,
      replied: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.repliedAt} IS NOT NULL AND ${outreachDrafts.repliedAt} >= ${since30})::int`,
      bounced: sql<number>`count(*) FILTER (WHERE ${outreachDrafts.bouncedAt} IS NOT NULL AND ${outreachDrafts.bouncedAt} >= ${since30})::int`,
    })
    .from(outreachDrafts)
    .where(eq(outreachDrafts.accountId, accountId));
  const sentCount = eng?.sent ?? 0;
  const openedCount = eng?.opened ?? 0;
  const repliedCount = eng?.replied ?? 0;
  const bouncedCount = eng?.bounced ?? 0;
  const replyRate =
    sentCount > 0 ? Number(((repliedCount / sentCount) * 100).toFixed(1)) : 0;
  const bounceRate =
    sentCount > 0 ? Number(((bouncedCount / sentCount) * 100).toFixed(1)) : 0;

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
    sentCount,
    openedCount,
    repliedCount,
    bouncedCount,
    replyRate,
    bounceRate,
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
  // Rank by the tenant-scoped combination of objective facility score plus
  // this account's engagement score. Engagement is per-tenant and lives on
  // `account_facilities.engagement_score`, so other tenants' replies and
  // bounces never influence this ordering.
  const rows = await db
    .select({
      id: facilities.id,
      npi: facilities.npi,
      name: facilities.name,
      facilityType: facilities.facilityType,
      city: facilities.city,
      state: facilities.state,
      beds: facilities.beds,
      signalScore: facilities.signalScore,
      engagementScore: accountFacilities.engagementScore,
    })
    .from(accountFacilities)
    .innerJoin(facilities, eq(facilities.id, accountFacilities.facilityId))
    .where(eq(accountFacilities.accountId, accountId))
    .orderBy(
      desc(
        sql`COALESCE(${facilities.signalScore},0) + COALESCE(${accountFacilities.engagementScore},0) - 50`,
      ),
    )
    .limit(limit);
  res.json(rows);
});

export default router;
