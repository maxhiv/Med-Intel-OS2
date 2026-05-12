import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  accounts,
  users,
  subAccounts,
  facilities,
  facilityContacts,
  accountFacilities,
  campaigns,
  campaignContacts,
  outreachDrafts,
  reportTemplates,
  reportRuns,
  draftEdits,
  syncBatches,
  contactEnrollments,
  sequences,
  sequenceSteps,
} from "@workspace/db";

export type SeededTenant = {
  accountId: string;
  userId: string;
  subAccountId: string;
  facilityId: string;
  contactId: string;
  campaignId: string;
  draftId: string;
  templateId: string;
};

export type SeededWorld = {
  tag: string;
  tenantA: SeededTenant;
  tenantB: SeededTenant;
  systemTemplateId: string;
  platformAdminUserId: string;
};

function uniqNpi(): string {
  return String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
}

async function seedTenant(tag: string, slug: string): Promise<SeededTenant> {
  const [account] = await db
    .insert(accounts)
    .values({
      name: `Test ${slug}`,
      slug,
      planTier: "starter",
      defaultCrm: "ghl",
      status: "active",
    })
    .returning();

  const [user] = await db
    .insert(users)
    .values({
      email: `${slug}@example.test`,
      role: "rep",
      accountId: account.id,
      firstName: "T",
      lastName: tag,
    })
    .returning();

  const [sub] = await db
    .insert(subAccounts)
    .values({
      accountId: account.id,
      name: `${slug} sub`,
      crmType: "ghl",
      isActive: true,
    })
    .returning();

  const [facility] = await db
    .insert(facilities)
    .values({
      npi: uniqNpi(),
      name: `${slug} Hospital`,
      facilityType: "hospital",
      state: "TX",
      city: "Austin",
      signalScore: 50,
    })
    .returning();

  await db.insert(accountFacilities).values({
    accountId: account.id,
    facilityId: facility.id,
    status: "identified",
  });

  const [contact] = await db
    .insert(facilityContacts)
    .values({
      facilityId: facility.id,
      firstName: "Alex",
      lastName: tag,
      title: "Director",
      email: `alex.${slug}@example.test`,
      confidenceScore: 70,
    })
    .returning();

  const [campaign] = await db
    .insert(campaigns)
    .values({
      accountId: account.id,
      subAccountId: sub.id,
      name: `${slug} campaign`,
      status: "draft",
    })
    .returning();

  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      accountId: account.id,
      contactId: contact.id,
      facilityId: facility.id,
      channel: "email",
      subject: `hello ${tag}`,
      body: `Body for ${tag}`,
      status: "pending",
    })
    .returning();

  const [template] = await db
    .insert(reportTemplates)
    .values({
      accountId: account.id,
      name: `${slug} template`,
      dataSources: ["facilities"],
      isSystemTemplate: false,
      isActive: true,
    })
    .returning();

  return {
    accountId: account.id,
    userId: user.id,
    subAccountId: sub.id,
    facilityId: facility.id,
    contactId: contact.id,
    campaignId: campaign.id,
    draftId: draft.id,
    templateId: template.id,
  };
}

export async function seedWorld(): Promise<SeededWorld> {
  const tag = randomUUID().slice(0, 8);
  const tenantA = await seedTenant("A", `test-a-${tag}`);
  const tenantB = await seedTenant("B", `test-b-${tag}`);

  const [sys] = await db
    .insert(reportTemplates)
    .values({
      name: `system-${tag}`,
      dataSources: ["facilities"],
      isSystemTemplate: true,
      isActive: true,
    })
    .returning();

  const [admin] = await db
    .insert(users)
    .values({
      email: `admin-${tag}@example.test`,
      role: "platform_admin",
      firstName: "Plat",
      lastName: "Admin",
    })
    .returning();

  return {
    tag,
    tenantA,
    tenantB,
    systemTemplateId: sys.id,
    platformAdminUserId: admin.id,
  };
}

/**
 * Ordered, fail-loud teardown. Children are removed before their parents to
 * satisfy FK constraints. Any unexpected DB error surfaces so we never claim
 * a clean state on top of stale fixtures.
 */
export async function teardownWorld(world: SeededWorld): Promise<void> {
  const acctIds = [world.tenantA.accountId, world.tenantB.accountId];
  const facIds = [world.tenantA.facilityId, world.tenantB.facilityId];
  const contactIds = [world.tenantA.contactId, world.tenantB.contactId];
  const draftIds = [world.tenantA.draftId, world.tenantB.draftId];

  // Resolve dependent ids before deletes so we can scope step deletes.
  const seqRows = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(inArray(sequences.accountId, acctIds));
  const seqIds = seqRows.map((r) => r.id);

  await db.delete(reportRuns).where(inArray(reportRuns.accountId, acctIds));
  await db
    .delete(reportTemplates)
    .where(eq(reportTemplates.id, world.systemTemplateId));
  await db
    .delete(reportTemplates)
    .where(inArray(reportTemplates.accountId, acctIds));
  await db.delete(syncBatches).where(inArray(syncBatches.accountId, acctIds));
  await db.delete(draftEdits).where(inArray(draftEdits.draftId, draftIds));
  await db
    .delete(outreachDrafts)
    .where(inArray(outreachDrafts.accountId, acctIds));
  await db
    .delete(contactEnrollments)
    .where(inArray(contactEnrollments.accountId, acctIds));
  await db
    .delete(campaignContacts)
    .where(inArray(campaignContacts.accountId, acctIds));
  if (seqIds.length > 0) {
    await db
      .delete(sequenceSteps)
      .where(inArray(sequenceSteps.sequenceId, seqIds));
  }
  await db.delete(sequences).where(inArray(sequences.accountId, acctIds));
  await db.delete(campaigns).where(inArray(campaigns.accountId, acctIds));
  await db
    .delete(facilityContacts)
    .where(inArray(facilityContacts.id, contactIds));
  await db
    .delete(accountFacilities)
    .where(inArray(accountFacilities.accountId, acctIds));
  await db.delete(facilities).where(inArray(facilities.id, facIds));
  await db.delete(subAccounts).where(inArray(subAccounts.accountId, acctIds));
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        world.tenantA.userId,
        world.tenantB.userId,
        world.platformAdminUserId,
      ]),
    );
  await db.delete(accounts).where(inArray(accounts.id, acctIds));
}
