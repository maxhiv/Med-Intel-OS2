import { eq, and, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  equipmentRecords,
  facilityContacts,
} from "@workspace/db";

const WEIGHTS: Record<string, number> = {
  depreciation_flag: 30,
  con_approved: 25,
  con_filed: 15,
  grant_awarded: 12,
  bond_issuance: 10,
  construction_permit: 10,
  leadership_change: 8,
  service_line_expansion: 12,
  job_posting: 6,
  news_expansion: 5,
  eol_equipment: 20,
  accreditation_renewal: 7,
  compliance_citation: 5,
  nih_grant: 8,
  clinical_trial: 6,
  fiscal_year_end: 5,
};

export async function computeFacilityScore(facilityId: string): Promise<number> {
  const sigs = await db
    .select()
    .from(purchaseSignals)
    .where(
      and(
        eq(purchaseSignals.facilityId, facilityId),
        eq(purchaseSignals.isActive, true),
      ),
    );

  let score = 0;
  for (const s of sigs) {
    const w = WEIGHTS[s.signalType] ?? 5;
    const conf = (s.confidence ?? 50) / 100;
    score += w * conf;
  }

  // Equipment urgency contribution
  const equip = await db
    .select()
    .from(equipmentRecords)
    .where(eq(equipmentRecords.facilityId, facilityId));
  for (const e of equip) {
    if (e.urgencyTier === "critical") score += 15;
    else if (e.urgencyTier === "high") score += 8;
    else if (e.urgencyTier === "medium") score += 3;
  }

  // Verified contact bonus
  const contacts = await db
    .select({ id: facilityContacts.id })
    .from(facilityContacts)
    .where(
      and(
        eq(facilityContacts.facilityId, facilityId),
        eq(facilityContacts.humanVerified, true),
      ),
    );
  if (contacts.length > 0) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function recomputeAllScores(): Promise<{ updated: number }> {
  const all = await db.select({ id: facilities.id }).from(facilities);
  let updated = 0;
  for (const f of all) {
    const newScore = await computeFacilityScore(f.id);
    await db
      .update(facilities)
      .set({ signalScore: newScore, updatedAt: new Date() })
      .where(eq(facilities.id, f.id));
    updated += 1;
  }
  return { updated };
}

export async function recomputeOne(facilityId: string): Promise<number> {
  const score = await computeFacilityScore(facilityId);
  await db
    .update(facilities)
    .set({ signalScore: score, updatedAt: new Date() })
    .where(eq(facilities.id, facilityId));
  return score;
}

// Re-export sql for callers
export { sql };
