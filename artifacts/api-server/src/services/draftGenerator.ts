import { eq, and } from "drizzle-orm";
import {
  db,
  campaigns,
  campaignContacts,
  facilityContacts,
  facilities,
  sequences,
  sequenceSteps,
  contactEnrollments,
  outreachDrafts,
  purchaseSignals,
} from "@workspace/db";
import { ai, ANTHROPIC_MODEL, ANTHROPIC_MAX_TOKENS } from "../lib/anthropic";

export async function generateDraftsForCampaign(
  campaignId: string,
  accountId: string,
): Promise<{ generated: number; skipped: number }> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, accountId)))
    .limit(1);
  if (!campaign) throw new Error("campaign_not_found");

  // Pick the first sequence belonging to this account/campaign or any account seq
  const [seq] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.accountId, accountId))
    .limit(1);

  let firstStep:
    | { id: string; subjectLine: string | null; bodyTemplate: string | null }
    | undefined;
  if (seq) {
    const [step] = await db
      .select({
        id: sequenceSteps.id,
        subjectLine: sequenceSteps.subjectLine,
        bodyTemplate: sequenceSteps.bodyTemplate,
      })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, seq.id))
      .orderBy(sequenceSteps.stepNum)
      .limit(1);
    firstStep = step;
  }

  const enrolled = await db
    .select({
      ccId: campaignContacts.id,
      contactId: campaignContacts.contactId,
    })
    .from(campaignContacts)
    .where(eq(campaignContacts.campaignId, campaignId));

  let generated = 0;
  let skipped = 0;

  for (const { ccId, contactId } of enrolled) {
    const [existingDraft] = await db
      .select({ id: outreachDrafts.id })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.contactId, contactId),
          eq(outreachDrafts.accountId, accountId),
        ),
      )
      .limit(1);
    if (existingDraft) {
      skipped += 1;
      continue;
    }

    const [contact] = await db
      .select()
      .from(facilityContacts)
      .where(eq(facilityContacts.id, contactId))
      .limit(1);
    if (!contact) {
      skipped += 1;
      continue;
    }

    const [facility] = await db
      .select()
      .from(facilities)
      .where(eq(facilities.id, contact.facilityId))
      .limit(1);
    if (!facility) {
      skipped += 1;
      continue;
    }

    const sigs = await db
      .select({
        signalType: purchaseSignals.signalType,
        signalValue: purchaseSignals.signalValue,
      })
      .from(purchaseSignals)
      .where(
        and(
          eq(purchaseSignals.facilityId, facility.id),
          eq(purchaseSignals.isActive, true),
        ),
      )
      .limit(5);

    let enrollmentId: string | undefined;
    if (seq) {
      const [enr] = await db
        .insert(contactEnrollments)
        .values({
          campaignContactId: ccId,
          sequenceId: seq.id,
          accountId,
        })
        .returning({ id: contactEnrollments.id });
      enrollmentId = enr.id;
    }

    let subject = firstStep?.subjectLine ?? `Re: ${facility.name}`;
    let body =
      firstStep?.bodyTemplate ??
      `Hi ${contact.firstName ?? "there"}, reaching out about ${facility.name}.`;
    let tokens: number | undefined;

    try {
      const prompt = `You write concise, high-trust outreach emails to medical equipment buyers at hospitals.

Facility: ${facility.name} (${facility.facilityType}, ${facility.city ?? ""}, ${facility.state ?? ""})
Signal score: ${facility.signalScore ?? 0}
Active signals: ${sigs.map((s) => `${s.signalType}${s.signalValue ? ` (${s.signalValue})` : ""}`).join(", ") || "none"}
Recipient: ${contact.firstName ?? ""} ${contact.lastName ?? ""}, ${contact.title ?? "buyer"}

Write a single short email (subject + 4-6 sentence body) referencing the most relevant signal. No fluff, no exclamation marks. Output JSON: {"subject": "...", "body": "..."}.`;

      const completion = await ai.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      });
      const text = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.subject === "string") subject = parsed.subject;
        if (typeof parsed.body === "string") body = parsed.body;
      }
      tokens =
        completion.usage.input_tokens + completion.usage.output_tokens;
    } catch {
      // Fall back to template — already populated above.
    }

    await db.insert(outreachDrafts).values({
      enrollmentId: enrollmentId ?? null,
      stepId: firstStep?.id ?? null,
      accountId,
      contactId,
      facilityId: facility.id,
      channel: "email",
      subject,
      body,
      aiModel: ANTHROPIC_MODEL,
      aiPromptVersion: "v1",
      generationTokens: tokens ?? null,
      status: "pending",
    });
    generated += 1;
  }

  return { generated, skipped };
}
