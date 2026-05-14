import { Router, type IRouter } from "express";
import { sql, desc, eq, and, ilike, inArray, type SQL } from "drizzle-orm";
import { db, conFilings, facilities, accountFacilities, subAccounts } from "@workspace/db";
import { requirePlatformAdmin, requireAccount } from "../middlewares/auth";
import { decodeStoredCredentials } from "../services/encryption";
import { logger } from "../lib/logger";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { recomputeAllScores } from "../services/signalScorer";
import { ingestClinicalTrials } from "../services/clinicalTrialsIngestor";
import { ingestConFilings, buildAdapters, recordIngestorRun } from "../services/conFilingsIngestor";
import { ingestNppes } from "../services/nppesIngestor";
import { ingestFda510k } from "../services/fda510kIngestor";
import { ingestFdaRecalls } from "../services/fdaRecallsIngestor";
import { ingestFdaMaude } from "../services/fdaMaudeIngestor";
import { ingestFdaClassification } from "../services/fdaClassificationIngestor";
import { ingestPropublica990 } from "../services/propublica990Ingestor";
import { ingestCmsData } from "../services/cmsDataIngestor";
import { ingestSecEdgar } from "../services/secEdgarIngestor";
import { ingestUsaSpending } from "../services/usaSpendingIngestor";
import { ingestSamGov } from "../services/samGovIngestor";
import { ingestEmma } from "../services/emmaIngestor";
import { ingestHcris } from "../services/hcrisIngestor";
import { ingestHrsa } from "../services/hrsaIngestor";
import { ingestUsda } from "../services/usdaIngestor";
import { ingestMedicareUtil } from "../services/medicareUtilIngestor";

const router: IRouter = Router();

// List recent CON filings, optionally filtered by state and approved-vs-filed
// status. Returned to any account user — CON data is public, not tenant-scoped.
// Mirrors `looksApproved()` in conFilingsIngestor.ts at the SQL level. Some
// adapters store normalized values ("approved"/"filed") while others persist
// raw source text (e.g. "Approved with conditions", "Application received"),
// so filtering and badge logic must match against the keyword pattern instead
// of an exact string.
const NORMALIZED_STATUS_SQL = sql<"approved" | "denied" | "under_review" | "pending" | null>`
  CASE
    WHEN ${conFilings.status} IS NULL THEN NULL
    WHEN ${conFilings.status} ~* 'approv|grant(ed)?|issued|cleared' THEN 'approved'
    WHEN ${conFilings.status} ~* 'deni|disapprov|reject|withdr|not approv|void|revok' THEN 'denied'
    WHEN ${conFilings.status} ~* 'review|under.?review|in.?review|pending review' THEN 'under_review'
    ELSE 'pending'
  END
`;

// Canonical path is /con-filings; /signals/con-filings is the legacy alias.
router.get(["/signals/con-filings", "/con-filings"], requireAccount, async (req, res) => {
  const accountId = req.currentAccount!.id;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const stateRaw = typeof req.query.state === "string" ? req.query.state.trim().toUpperCase() : "";
  const statusRaw = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
  const equipmentTypeRaw = typeof req.query.equipmentType === "string" ? req.query.equipmentType.trim() : "";
  const fromDateRaw = typeof req.query.fromDate === "string" ? req.query.fromDate.trim() : "";
  const toDateRaw = typeof req.query.toDate === "string" ? req.query.toDate.trim() : "";

  // Multi-state: ?states=IL,NY,CT (comma-separated) takes precedence over ?state.
  const statesRaw = typeof req.query.states === "string" ? req.query.states.trim().toUpperCase() : "";
  const stateList = statesRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length === 2);

  const filters: SQL[] = [];
  if (stateList.length > 1) {
    filters.push(inArray(conFilings.state, stateList));
  } else if (stateList.length === 1) {
    filters.push(eq(conFilings.state, stateList[0]));
  } else if (stateRaw.length === 2) {
    filters.push(eq(conFilings.state, stateRaw));
  }
  if (statusRaw === "approved") {
    filters.push(sql`${conFilings.status} ~* 'approv|grant(ed)?|issued|cleared'`);
  } else if (statusRaw === "denied") {
    filters.push(sql`${conFilings.status} ~* 'deni|disapprov|reject|withdr|not approv|void|revok'`);
  } else if (statusRaw === "under_review") {
    filters.push(sql`${conFilings.status} ~* 'review|under.?review|in.?review|pending review'`);
  } else if (statusRaw === "pending") {
    filters.push(
      sql`${conFilings.status} IS NOT NULL AND ${conFilings.status} !~* 'approv|grant(ed)?|issued|cleared|deni|disapprov|reject|withdr|void|revok|review|under.?review|in.?review'`,
    );
  } else if (statusRaw === "filed") {
    // Legacy alias: anything non-approved
    filters.push(
      sql`${conFilings.status} IS NOT NULL AND ${conFilings.status} !~* 'approv|grant(ed)?|issued|cleared'`,
    );
  }
  if (equipmentTypeRaw) {
    filters.push(ilike(conFilings.equipmentType, `%${equipmentTypeRaw}%`));
  }
  if (fromDateRaw) {
    const fromDate = new Date(fromDateRaw);
    if (!Number.isNaN(fromDate.getTime())) {
      filters.push(
        sql`COALESCE(${conFilings.filingDate}, ${conFilings.createdAt}::date) >= ${fromDate.toISOString().slice(0, 10)}::date`,
      );
    }
  }
  if (toDateRaw) {
    const toDate = new Date(toDateRaw);
    if (!Number.isNaN(toDate.getTime())) {
      filters.push(
        sql`COALESCE(${conFilings.filingDate}, ${conFilings.createdAt}::date) <= ${toDate.toISOString().slice(0, 10)}::date`,
      );
    }
  }
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // CON filings come from public state regulators and aren't tenant-owned, so
  // every account user sees the full feed. To avoid dead facility links we
  // mark each row's matched facility as accessible only when it's in the
  // current account's facility set.
  const ownedRows = await db
    .select({ id: accountFacilities.facilityId })
    .from(accountFacilities)
    .where(eq(accountFacilities.accountId, accountId));
  const ownedSet = new Set(ownedRows.map((r) => r.id));

  const rows = await db
    .select({
      id: conFilings.id,
      facilityId: conFilings.facilityId,
      facilityName: facilities.name,
      state: conFilings.state,
      filingDate: conFilings.filingDate,
      decisionDate: conFilings.decisionDate,
      equipmentType: conFilings.equipmentType,
      modality: conFilings.modality,
      requestedAmount: conFilings.requestedAmount,
      approvedAmount: conFilings.approvedAmount,
      status: conFilings.status,
      statusNormalized: NORMALIZED_STATUS_SQL,
      applicantName: conFilings.applicantName,
      filingUrl: conFilings.filingUrl,
      notes: conFilings.notes,
      matchScore: conFilings.matchScore,
      matchField: conFilings.matchField,
      reviewStatus: conFilings.reviewStatus,
      createdAt: conFilings.createdAt,
    })
    .from(conFilings)
    .leftJoin(facilities, eq(facilities.id, conFilings.facilityId))
    .where(whereClause)
    .orderBy(
      desc(sql`COALESCE(${conFilings.filingDate}, ${conFilings.createdAt}::date)`),
    )
    .limit(limit)
    .offset(offset);

  const data = rows.map((r) => ({
    ...r,
    matchScore: r.matchScore == null ? null : Number(r.matchScore),
    facilityAccessible: r.facilityId ? ownedSet.has(r.facilityId) : false,
  }));

  const [{ c: total }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(conFilings)
    .where(whereClause);

  const stateRows = await db
    .selectDistinct({ state: conFilings.state })
    .from(conFilings)
    .orderBy(conFilings.state);
  const states = stateRows.map((r) => r.state).filter((s): s is string => !!s);

  res.json({ data, total, limit, offset, states });
});

// Per-state filing counts — used by the CON States page for real activity numbers.
router.get(["/signals/con-filings/state-counts", "/con-filings/state-counts"], requireAccount, async (_req, res) => {
  const rows = await db
    .select({
      state: conFilings.state,
      count: sql<number>`count(*)::int`,
    })
    .from(conFilings)
    .groupBy(conFilings.state)
    .orderBy(conFilings.state);

  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (r.state) counts[r.state] = r.count;
  }
  res.json(counts);
});

// Push a CON filing as a pipeline opportunity to a GHL sub-account.
// Body: { subAccountId: string, opportunityName?: string }
// Accessible at both /signals/con-filings/:id/push-to-crm (legacy) and
// /con-filings/:id/push-to-crm (canonical per spec).
async function handlePushToCrm(req: import("express").Request, res: import("express").Response) {
    const accountId = req.currentAccount!.id;
    const filingId = String(req.params.id);
    const subAccountId = typeof req.body?.subAccountId === "string" ? req.body.subAccountId.trim() : "";
    const opportunityNameOverride = typeof req.body?.opportunityName === "string" ? req.body.opportunityName.trim() : "";

    if (!subAccountId) {
      res.status(400).json({ error: "subAccountId_required" });
      return;
    }

    const [filing] = await db
      .select()
      .from(conFilings)
      .where(eq(conFilings.id, filingId))
      .limit(1);
    if (!filing) {
      res.status(404).json({ error: "filing_not_found" });
      return;
    }

    const [sub] = await db
      .select()
      .from(subAccounts)
      .where(and(eq(subAccounts.id, subAccountId), eq(subAccounts.accountId, accountId)))
      .limit(1);
    if (!sub) {
      res.status(404).json({ error: "sub_account_not_found" });
      return;
    }

    if (sub.crmType !== "ghl") {
      res.status(400).json({ error: "unsupported_crm_type_for_push", crmType: sub.crmType ?? null });
      return;
    }

    const creds = decodeStoredCredentials<{ accessToken?: string; locationId?: string }>(
      sub.crmCredentials ?? {},
    );

    if (!creds.accessToken || !creds.locationId) {
      res.status(400).json({ error: "ghl_missing_credentials" });
      return;
    }

    // Lookup matched facility (if any) to enrich the opportunity with site context.
    let matchedFacility: { name: string | null; address1: string | null; city: string | null; state: string | null; npi: string } | null = null;
    if (filing.facilityId) {
      const [fac] = await db
        .select({ name: facilities.name, address1: facilities.address1, city: facilities.city, state: facilities.state, npi: facilities.npi })
        .from(facilities)
        .where(eq(facilities.id, filing.facilityId))
        .limit(1);
      matchedFacility = fac ?? null;
    }

    const opportunityName =
      opportunityNameOverride ||
      `CON: ${filing.applicantName || matchedFacility?.name || "Unknown"} — ${filing.state} — ${filing.equipmentType || filing.modality || "Equipment"}`;

    const monetaryValue = Number(filing.approvedAmount ?? filing.requestedAmount ?? 0);

    const ghlHeaders = {
      Authorization: `Bearer ${creds.accessToken}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    try {
      // Step 1: find the "CON Pre-Qualified" pipeline stage in GHL.
      let targetPipelineId: string | null = null;
      let targetStageId: string | null = null;
      try {
        const pipelinesRes = await fetch(
          `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${encodeURIComponent(creds.locationId!)}`,
          { headers: ghlHeaders },
        );
        if (pipelinesRes.ok) {
          const pb = await pipelinesRes.json() as { pipelines?: Array<{ id: string; stages?: Array<{ id: string; name: string }> }> };
          for (const pipeline of pb.pipelines ?? []) {
            const stage = pipeline.stages?.find((s) => /con.?pre.?qual/i.test(s.name));
            if (stage) { targetPipelineId = pipeline.id; targetStageId = stage.id; break; }
          }
          if (!targetPipelineId && pb.pipelines?.[0]) {
            targetPipelineId = pb.pipelines[0].id;
            targetStageId = pb.pipelines[0].stages?.[0]?.id ?? null;
          }
        }
      } catch (err) {
        logger.warn({ err }, "signals: GHL pipeline lookup failed, proceeding without stage");
      }

      // Step 2: Upsert a contact from the filing applicant, enriched with matched facility address.
      const contactPayload = {
        locationId: creds.locationId,
        companyName: filing.applicantName || matchedFacility?.name || "Unknown applicant",
        source: "MedIntel OS — CON Filing",
        tags: ["medintel-con", `state-${filing.state}`, `status-${filing.status?.toLowerCase().replace(/\s/g, "-") ?? "unknown"}`],
        ...(matchedFacility?.address1 ? { address1: matchedFacility.address1 } : {}),
        ...(matchedFacility?.city    ? { city:     matchedFacility.city }    : {}),
        ...(matchedFacility?.state   ? { state:    matchedFacility.state }   : {}),
      };
      const upsertRes = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
        method: "POST",
        headers: ghlHeaders,
        body: JSON.stringify(contactPayload),
      });
      if (!upsertRes.ok) {
        const errText = await upsertRes.text().catch(() => "");
        logger.warn({ status: upsertRes.status, body: errText, filingId }, "signals: GHL contact upsert failed");
        res.status(502).json({ ok: false, error: "ghl_contact_upsert_failed", ghlStatus: upsertRes.status });
        return;
      }
      const upsertBody = await upsertRes.json().catch(() => ({})) as { contact?: { id?: string }; id?: string };
      const crmContactId = upsertBody?.contact?.id ?? (upsertBody as { id?: string }).id ?? null;

      // Step 3: Search for an existing GHL opportunity created from this filing (idempotent upsert).
      let existingOpportunityId: string | null = null;
      try {
        const searchRes = await fetch(
          `https://services.leadconnectorhq.com/opportunities/search?location_id=${encodeURIComponent(creds.locationId!)}&q=${encodeURIComponent(filingId)}`,
          { headers: ghlHeaders },
        );
        if (searchRes.ok) {
          const searchBody = await searchRes.json() as { opportunities?: Array<{ id: string; customFields?: Array<{ key: string; field_value: string }> }> };
          const found = searchBody.opportunities?.find((o) =>
            o.customFields?.some((cf) => cf.key === "con_filing_id" && cf.field_value === filingId),
          );
          if (found) existingOpportunityId = found.id;
        }
      } catch (err) {
        logger.warn({ err }, "signals: GHL opportunity search failed, will create new");
      }

      const opportunityPayload = {
        pipelineId: targetPipelineId,
        ...(targetStageId  ? { pipelineStageId: targetStageId } : {}),
        locationId: creds.locationId,
        name: opportunityName,
        monetaryValue,
        status: "open",
        ...(crmContactId   ? { contactId: crmContactId }        : {}),
        customFields: [
          { key: "con_state",       field_value: filing.state },
          { key: "equipment_type",  field_value: filing.equipmentType || filing.modality || "" },
          { key: "filing_date",     field_value: String(filing.filingDate ?? "") },
          { key: "con_filing_id",   field_value: filingId },
          { key: "facility_name",   field_value: matchedFacility?.name  ?? "" },
          { key: "facility_npi",    field_value: matchedFacility?.npi   ?? "" },
        ],
      };

      // Step 4: Update existing or create new opportunity.
      let oppRes: Response;
      let action: "created" | "updated";
      if (existingOpportunityId) {
        oppRes = await fetch(
          `https://services.leadconnectorhq.com/opportunities/${existingOpportunityId}`,
          { method: "PUT", headers: ghlHeaders, body: JSON.stringify(opportunityPayload) },
        );
        action = "updated";
      } else {
        oppRes = await fetch(
          "https://services.leadconnectorhq.com/opportunities/",
          { method: "POST", headers: ghlHeaders, body: JSON.stringify(opportunityPayload) },
        );
        action = "created";
      }

      if (!oppRes.ok) {
        const errText = await oppRes.text().catch(() => "");
        logger.warn({ status: oppRes.status, body: errText, filingId, action }, "signals: GHL opportunity upsert failed");
        res.status(502).json({ ok: false, error: "ghl_opportunity_upsert_failed", ghlStatus: oppRes.status, action });
        return;
      }
      const oppBody = await oppRes.json().catch(() => ({})) as { opportunity?: { id?: string }; id?: string };
      const opportunityId = (oppBody as { opportunity?: { id?: string } })?.opportunity?.id ?? (oppBody as { id?: string }).id ?? existingOpportunityId;

      logger.info({ filingId, subAccountId, targetPipelineId, targetStageId, action }, "signals: CON filing pushed to GHL as opportunity");

      res.json({ ok: true, action, crmContactId, opportunityId, opportunityName, monetaryValue, pipelineId: targetPipelineId, stageId: targetStageId, facilityLinked: !!matchedFacility });
    } catch (err) {
      logger.warn({ err, filingId, subAccountId }, "signals: push-to-crm failed");
      res.status(502).json({ ok: false, error: "push_failed", message: String(err) });
    }
}

// Register push-to-crm at both paths: legacy and canonical per spec.
router.post("/signals/con-filings/:id/push-to-crm", requireAccount, handlePushToCrm);
router.post("/con-filings/:id/push-to-crm", requireAccount, handlePushToCrm);

// Stream an AI-generated cold outreach email for a CON filing.
// Uses SSE so the client can show the text as it arrives.
// On completion, the caller can save the result to POST /drafts.
async function handleDraftEmail(req: import("express").Request, res: import("express").Response) {
  const accountId = req.currentAccount!.id;
  const filingId = String(req.params.id);

  const [filing] = await db
    .select({
      id: conFilings.id,
      applicantName: conFilings.applicantName,
      state: conFilings.state,
      equipmentType: conFilings.equipmentType,
      modality: conFilings.modality,
      status: conFilings.status,
      approvedAmount: conFilings.approvedAmount,
      requestedAmount: conFilings.requestedAmount,
      filingDate: conFilings.filingDate,
      facilityId: conFilings.facilityId,
      notes: conFilings.notes,
    })
    .from(conFilings)
    .where(eq(conFilings.id, filingId))
    .limit(1);

  if (!filing) {
    res.status(404).json({ error: "filing_not_found" });
    return;
  }

  let facilityContext = "";
  if (filing.facilityId) {
    const [fac] = await db
      .select({ name: facilities.name, city: facilities.city, address1: facilities.address1 })
      .from(facilities)
      .where(eq(facilities.id, filing.facilityId))
      .limit(1);
    if (fac?.name) {
      facilityContext = `\nFacility on record: ${fac.name}${fac.city ? `, ${fac.city}` : ""}${fac.address1 ? ` — ${fac.address1}` : ""}`;
    }
  }

  const amount = filing.approvedAmount ?? filing.requestedAmount;
  const amountStr = amount != null ? `$${Math.round(Number(amount)).toLocaleString()}` : null;

  const systemPrompt = `You are an expert B2B medical-equipment sales copywriter. Write concise, personalized cold outreach emails for a medical capital-equipment company that wants to reach healthcare facilities that are expanding.

Your emails:
- Are addressed to "the Procurement / Capital Equipment Team" when no named contact is available
- Lead with the specific CON filing details (state, equipment type, approved amount) to show you did your homework
- Explain how the company can help them acquire the approved equipment efficiently
- Include a soft call to action (a brief call or reply)
- Are 150–200 words, professional yet approachable
- Do NOT use generic filler phrases like "I hope this email finds you well"
- Do NOT invent facts beyond what is provided

Format: Return ONLY the email text — a Subject line first (prefixed "Subject: "), then a blank line, then the body. No commentary.`;

  const userPrompt = `Generate a cold outreach email for the following CON filing:

- Applicant / facility name: ${filing.applicantName || "Unknown applicant"}
- State: ${filing.state}
- Equipment type: ${filing.equipmentType || filing.modality || "medical equipment"}
- CON status: ${filing.status || "Approved"}
- Approved / requested amount: ${amountStr || "not specified"}
- Filing date: ${filing.filingDate ? new Date(filing.filingDate).toLocaleDateString() : "recent"}${facilityContext}
${filing.notes ? `\nAdditional context: ${filing.notes}` : ""}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, filingId, model: "claude-sonnet-4-6" })}\n\n`);
    res.end();
  } catch (err) {
    logger.error({ err, filingId, accountId }, "signals: draft-email stream failed");
    res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    res.end();
  }
}

router.post("/signals/con-filings/:id/draft-email", requireAccount, handleDraftEmail);
router.post("/con-filings/:id/draft-email", requireAccount, handleDraftEmail);

// Push a generated draft email to GHL as a note on the filing's contact.
// Body: { subAccountId, subject, body }
async function handlePushDraftToGhl(req: import("express").Request, res: import("express").Response) {
  const accountId = req.currentAccount!.id;
  const filingId = String(req.params.id);
  const subAccountId = typeof req.body?.subAccountId === "string" ? req.body.subAccountId.trim() : "";
  const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";

  if (!subAccountId) {
    res.status(400).json({ error: "subAccountId_required" });
    return;
  }
  if (!body) {
    res.status(400).json({ error: "body_required" });
    return;
  }

  const [filing] = await db
    .select()
    .from(conFilings)
    .where(eq(conFilings.id, filingId))
    .limit(1);
  if (!filing) {
    res.status(404).json({ error: "filing_not_found" });
    return;
  }

  const [sub] = await db
    .select()
    .from(subAccounts)
    .where(and(eq(subAccounts.id, subAccountId), eq(subAccounts.accountId, accountId)))
    .limit(1);
  if (!sub) {
    res.status(404).json({ error: "sub_account_not_found" });
    return;
  }
  if (sub.crmType !== "ghl") {
    res.status(400).json({ error: "unsupported_crm_type", crmType: sub.crmType ?? null });
    return;
  }

  const creds = decodeStoredCredentials<{ accessToken?: string; locationId?: string }>(sub.crmCredentials ?? {});
  if (!creds.accessToken || !creds.locationId) {
    res.status(400).json({ error: "ghl_missing_credentials" });
    return;
  }

  const ghlHeaders = {
    Authorization: `Bearer ${creds.accessToken}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Upsert a GHL contact for the filing applicant so we have a contactId to attach the note to.
  let matchedFacility: { name: string | null; address1: string | null; city: string | null; state: string | null } | null = null;
  if (filing.facilityId) {
    const [fac] = await db
      .select({ name: facilities.name, address1: facilities.address1, city: facilities.city, state: facilities.state })
      .from(facilities)
      .where(eq(facilities.id, filing.facilityId))
      .limit(1);
    matchedFacility = fac ?? null;
  }

  try {
    const contactPayload = {
      locationId: creds.locationId,
      companyName: filing.applicantName || matchedFacility?.name || "Unknown applicant",
      source: "MedIntel OS — CON Filing",
      tags: ["medintel-con", `state-${filing.state}`],
      ...(matchedFacility?.address1 ? { address1: matchedFacility.address1 } : {}),
      ...(matchedFacility?.city ? { city: matchedFacility.city } : {}),
      ...(matchedFacility?.state ? { state: matchedFacility.state } : {}),
    };

    const upsertRes = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: ghlHeaders,
      body: JSON.stringify(contactPayload),
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text().catch(() => "");
      logger.warn({ status: upsertRes.status, body: errText, filingId }, "signals: GHL contact upsert failed for draft push");
      res.status(502).json({ ok: false, error: "ghl_contact_upsert_failed", ghlStatus: upsertRes.status });
      return;
    }

    const upsertBody = await upsertRes.json().catch(() => ({})) as { contact?: { id?: string }; id?: string };
    const crmContactId = upsertBody?.contact?.id ?? (upsertBody as { id?: string }).id ?? null;

    if (!crmContactId) {
      res.status(502).json({ ok: false, error: "ghl_no_contact_id" });
      return;
    }

    // Create a GHL outreach task for the rep to execute, with the email draft attached.
    const taskTitle = subject ? `Outreach: ${subject}` : `CON Outreach — ${filing.applicantName || filing.state}`;
    const taskBody = subject ? `Subject: ${subject}\n\n${body}` : body;
    const dueDateIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days out
    const taskRes = await fetch(`https://services.leadconnectorhq.com/contacts/${crmContactId}/tasks`, {
      method: "POST",
      headers: ghlHeaders,
      body: JSON.stringify({
        title: taskTitle,
        body: taskBody,
        dueDate: dueDateIso,
        completed: false,
      }),
    });

    if (!taskRes.ok) {
      const errText = await taskRes.text().catch(() => "");
      logger.warn({ status: taskRes.status, body: errText, filingId, crmContactId }, "signals: GHL task creation failed");
      res.status(502).json({ ok: false, error: "ghl_task_creation_failed", ghlStatus: taskRes.status });
      return;
    }

    const taskResult = await taskRes.json().catch(() => ({})) as { task?: { id?: string }; id?: string };
    const taskId = (taskResult as { task?: { id?: string } })?.task?.id ?? (taskResult as { id?: string }).id ?? null;

    logger.info({ filingId, subAccountId, crmContactId, taskId }, "signals: CON draft email pushed to GHL as outreach task");
    res.json({ ok: true, crmContactId, taskId });
  } catch (err) {
    logger.warn({ err, filingId, subAccountId }, "signals: push-draft-to-ghl failed");
    res.status(502).json({ ok: false, error: "push_failed", message: String(err) });
  }
}

router.post("/signals/con-filings/:id/push-draft-to-ghl", requireAccount, handlePushDraftToGhl);
router.post("/con-filings/:id/push-draft-to-ghl", requireAccount, handlePushDraftToGhl);

router.post("/signals/recompute", requirePlatformAdmin, async (_req, res) => {
  const result = await recomputeAllScores();
  res.json(result);
});

// Manually trigger the ClinicalTrials.gov ingestor. Useful for ops + tests so
// new signals can be backfilled without waiting for the 04:30 cron tick.
router.post(
  "/signals/ingest/clinicaltrials",
  requirePlatformAdmin,
  async (req, res) => {
    const raw = req.query.limit;
    let limit: number | undefined;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ error: "limit_must_be_positive_number" });
        return;
      }
      limit = Math.floor(n);
    }
    const result = await ingestClinicalTrials({ limit });
    res.json(result);
  },
);

// Manually trigger the state CON-filings ingestor.
// Optional ?state=XX runs only the adapter for that state (case-insensitive).
// Omit for a full Tier-A batch across all configured adapters.
router.post(
  "/signals/ingest/con-filings",
  requirePlatformAdmin,
  async (req, res) => {
    const stateParam =
      typeof req.query.state === "string" ? req.query.state.trim().toUpperCase() : "";

    const allAdapters = buildAdapters();

    const adapters =
      stateParam.length === 2
        ? allAdapters.filter((a) => a.state === stateParam)
        : allAdapters;

    if (stateParam && adapters.length === 0) {
      res.status(404).json({
        error: "no_adapter_for_state",
        state: stateParam,
        available: [...new Set(allAdapters.map((a) => a.state))],
      });
      return;
    }

    const t0 = Date.now();
    let result;
    try {
      result = await ingestConFilings({ adapters });
      recordIngestorRun("conFilings", Date.now() - t0, "success");
    } catch (err) {
      recordIngestorRun("conFilings", Date.now() - t0, "error");
      throw err;
    }
    res.json(result);
  },
);

// Manually trigger any combination of the no-key free-API ingestors.
// Use ?source={name} to run a single source; omit for all.
// Valid sources: nppes, fda_510k, fda_recalls, fda_maude, fda_class,
//   propublica_990, cms_data, sec_edgar, usa_spending,
//   sam_gov, emma_bonds, hcris, hrsa, usda, medicare_util
router.post(
  "/signals/ingest/free-apis",
  requirePlatformAdmin,
  async (req, res) => {
    const sourceParam =
      typeof req.query.source === "string" ? req.query.source.trim() : "";

    const ingestors: Record<
      string,
      () => Promise<{ signalsInserted: number; errors: number }>
    > = {
      nppes:          () => ingestNppes({ limit: 50 }),
      fda_510k:       () => ingestFda510k({ limit: 50 }),
      fda_recalls:    () => ingestFdaRecalls({ limit: 50 }),
      fda_maude:      () => ingestFdaMaude({ limit: 50 }),
      fda_class:      () => ingestFdaClassification({ limit: 50 }),
      propublica_990: () => ingestPropublica990({ limit: 40 }),
      cms_data:       () => ingestCmsData({ limit: 50 }),
      sec_edgar:      () => ingestSecEdgar({ limit: 40 }),
      usa_spending:   () => ingestUsaSpending({ limit: 40 }),
      sam_gov:        () => ingestSamGov({ limit: 50 }),
      emma_bonds:     () => ingestEmma({ limit: 30 }),
      hcris:          () => ingestHcris({ limit: 50 }),
      hrsa:           () => ingestHrsa({ limit: 50 }),
      usda:           () => ingestUsda({ limit: 50 }),
      medicare_util:  () => ingestMedicareUtil({ limit: 50 }),
    };

    if (sourceParam && !ingestors[sourceParam]) {
      res.status(400).json({
        error: "unknown_source",
        valid: Object.keys(ingestors),
      });
      return;
    }

    const toRun = sourceParam
      ? { [sourceParam]: ingestors[sourceParam] }
      : ingestors;

    const results: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(toRun)) {
      try {
        results[name] = await fn();
      } catch (err) {
        results[name] = { error: String(err) };
      }
    }
    res.json(results);
  },
);

export default router;
