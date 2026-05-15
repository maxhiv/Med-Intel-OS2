import { Router, type IRouter } from "express";
import { sql, desc, eq, and } from "drizzle-orm";
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

router.get("/dashboard/summary", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;

  const countsResult = await db.execute(sql`
    SELECT
      COUNT(DISTINCT f.id)::int                                             AS "totalFacilities",
      COUNT(DISTINCT fc.id)::int                                            AS "totalContacts",
      COUNT(DISTINCT fc.id) FILTER (WHERE fc.human_verified = true)::int   AS "verifiedContacts",
      COUNT(DISTINCT ps.id) FILTER (WHERE ps.is_active = true)::int        AS "activeSignals",
      COALESCE(AVG(f.signal_score), 0)::float                              AS "avgScore"
    FROM account_facilities af
    JOIN facilities f ON f.id = af.facility_id
    LEFT JOIN facility_contacts fc ON fc.facility_id = f.id
    LEFT JOIN purchase_signals ps ON ps.facility_id = f.id
    WHERE af.account_id = ${accountId}
  `);
  const counts = countsResult.rows[0] as Record<string, unknown>;

  const signalsByTypeResult = await db.execute(sql`
    SELECT ps.signal_type::text AS "signalType", COUNT(*)::int AS count
    FROM account_facilities af
    JOIN purchase_signals ps ON ps.facility_id = af.facility_id
    WHERE af.account_id = ${accountId}
      AND ps.is_active = true
    GROUP BY ps.signal_type
  `);
  const signalsByType = signalsByTypeResult.rows as Array<Record<string, unknown>>;

  const [pendingDrafts] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.accountId, accountId), eq(outreachDrafts.status, "pending")));

  const [approvedDrafts] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(outreachDrafts)
    .where(and(eq(outreachDrafts.accountId, accountId), eq(outreachDrafts.status, "approved")));

  const [myCampaigns] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(eq(campaigns.accountId, accountId));

  const today = new Date().toISOString().slice(0, 10);
  const [batchesToday] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(syncBatches)
    .where(and(eq(syncBatches.accountId, accountId), eq(syncBatches.batchDate, today)));

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
  const replyRate = sentCount > 0 ? Number(((repliedCount / sentCount) * 100).toFixed(1)) : 0;
  const bounceRate = sentCount > 0 ? Number(((bouncedCount / sentCount) * 100).toFixed(1)) : 0;

  res.json({
    totalFacilities: counts?.totalFacilities ?? 0,
    totalContacts: counts?.totalContacts ?? 0,
    verifiedContacts: counts?.verifiedContacts ?? 0,
    activeSignals: counts?.activeSignals ?? 0,
    pendingDrafts: pendingDrafts.c,
    approvedDrafts: approvedDrafts.c,
    batchesToday: batchesToday.c,
    myCampaigns: myCampaigns.c,
    avgSignalScore: Number(Number(counts?.avgScore ?? 0).toFixed(1)),
    signalsByType: signalsByType.map((r) => ({
      signalType: r.signalType,
      count: r.count,
    })),
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
    .from(accountFacilities)
    .innerJoin(purchaseSignals, eq(purchaseSignals.facilityId, accountFacilities.facilityId))
    .innerJoin(facilities, eq(facilities.id, purchaseSignals.facilityId))
    .where(
      and(
        eq(accountFacilities.accountId, accountId),
        eq(purchaseSignals.isActive, true),
      ),
    )
    .orderBy(desc(purchaseSignals.detectedAt))
    .limit(limit);

  res.json(rows);
});

router.get("/dashboard/top-facilities", requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Number(req.query.limit) || 10, 50);

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
