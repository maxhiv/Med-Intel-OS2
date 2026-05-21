/**
 * databaseAndActionTools — tools the ProspectingAgent uses to read MedIntel's
 * own database and to take (draft-only) actions.
 *
 * Adapted from the handoff's databaseAndActionTools.js. The handoff assumed
 * its own schema (capital_triggers, equipment_inventory, contacts, …); this
 * version targets the REAL v1.0/v2.0 tables: facilities, purchase_signals,
 * equipment_records, facility_contacts, opportunities, outreach_drafts.
 *
 * RLS: the chat route wraps the whole request in withRLS(accountId), so the
 * shared `db` is already account-scoped — no per-query context needed here.
 *
 * Rule 1 (no auto-send): `draft_outreach` only ever writes an outreach_drafts
 * row with status 'pending'. Nothing in this file sends anything.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  facilities,
  purchaseSignals,
  equipmentRecords,
  facilityContacts,
  opportunities,
  outreachDrafts,
  chatSessionProspects,
} from "@workspace/db";
import type { AgentToolDefinition, ToolBuildContext, ToolRegistry, ToolExecutor } from "./types";

export function buildDatabaseAndActionTools(ctx: ToolBuildContext): ToolRegistry {
  const definitions: AgentToolDefinition[] = [];
  const executors = new Map<string, ToolExecutor>();
  const add = (def: AgentToolDefinition, exec: ToolExecutor) => {
    definitions.push(def);
    executors.set(def.name, exec);
  };

  // ─── db_query_facilities ──────────────────────────────────────────────────
  add(
    {
      name: "db_query_facilities",
      description:
        "Search MedIntel's facilities table by structured filters. Returns the global CMS-derived facility universe (id, name, NPI, CCN, type, state, beds, signal score).",
      input_schema: {
        type: "object",
        properties: {
          state: { type: "string", description: "Two-letter state code" },
          facilityType: { type: "string" },
          npi: { type: "string" },
          cmsId: { type: "string", description: "CMS Certification Number (CCN)" },
          nameContains: { type: "string" },
          minSignalScore: { type: "integer" },
          limit: { type: "integer", description: "default 25, max 100" },
        },
      },
    },
    async (args) => {
      const conds = [];
      if (typeof args.state === "string") conds.push(eq(facilities.state, args.state));
      if (typeof args.facilityType === "string")
        conds.push(eq(facilities.facilityType, args.facilityType));
      if (typeof args.npi === "string") conds.push(eq(facilities.npi, args.npi));
      if (typeof args.cmsId === "string") conds.push(eq(facilities.cmsId, args.cmsId));
      if (typeof args.nameContains === "string")
        conds.push(sql`${facilities.name} ILIKE ${"%" + args.nameContains + "%"}`);
      if (typeof args.minSignalScore === "number")
        conds.push(sql`${facilities.signalScore} >= ${args.minSignalScore}`);
      const limit = Math.min(Number(args.limit) || 25, 100);
      const rows = await db
        .select({
          id: facilities.id,
          name: facilities.name,
          npi: facilities.npi,
          cmsId: facilities.cmsId,
          facilityType: facilities.facilityType,
          state: facilities.state,
          city: facilities.city,
          beds: facilities.beds,
          ownership: facilities.ownership,
          systemName: facilities.systemName,
          signalScore: facilities.signalScore,
        })
        .from(facilities)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(facilities.signalScore))
        .limit(limit);
      return { content: { facilities: rows, count: rows.length } };
    },
  );

  // ─── db_query_signals ─────────────────────────────────────────────────────
  add(
    {
      name: "db_query_signals",
      description:
        "List active purchase signals (capital triggers) for a facility — signal type, value, confidence, source, detected date.",
      input_schema: {
        type: "object",
        properties: {
          facilityId: { type: "string" },
          signalType: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["facilityId"],
      },
    },
    async (args) => {
      const conds = [
        eq(purchaseSignals.facilityId, String(args.facilityId)),
        eq(purchaseSignals.isActive, true),
      ];
      if (typeof args.signalType === "string")
        conds.push(sql`${purchaseSignals.signalType}::text = ${args.signalType}`);
      const rows = await db
        .select({
          signalType: purchaseSignals.signalType,
          signalValue: purchaseSignals.signalValue,
          confidence: purchaseSignals.confidence,
          source: purchaseSignals.source,
          detectedAt: purchaseSignals.detectedAt,
          metadata: purchaseSignals.metadata,
        })
        .from(purchaseSignals)
        .where(and(...conds))
        .orderBy(desc(purchaseSignals.detectedAt))
        .limit(Math.min(Number(args.limit) || 25, 100));
      return { content: { signals: rows, count: rows.length } };
    },
  );

  // ─── db_query_equipment ───────────────────────────────────────────────────
  add(
    {
      name: "db_query_equipment",
      description:
        "Get known equipment records for a facility — modality, manufacturer, model, install year.",
      input_schema: {
        type: "object",
        properties: { facilityId: { type: "string" } },
        required: ["facilityId"],
      },
    },
    async (args) => {
      const rows = await db
        .select()
        .from(equipmentRecords)
        .where(eq(equipmentRecords.facilityId, String(args.facilityId)))
        .limit(100);
      return { content: { equipment: rows, count: rows.length } };
    },
  );

  // ─── db_query_contacts ────────────────────────────────────────────────────
  add(
    {
      name: "db_query_contacts",
      description:
        "Look up known contacts at a facility (decision-makers, technical staff) with title and buying-authority score.",
      input_schema: {
        type: "object",
        properties: { facilityId: { type: "string" } },
        required: ["facilityId"],
      },
    },
    async (args) => {
      const rows = await db
        .select({
          id: facilityContacts.id,
          firstName: facilityContacts.firstName,
          lastName: facilityContacts.lastName,
          title: facilityContacts.title,
          email: facilityContacts.email,
          phone: facilityContacts.phone,
          buyingAuthorityScore: facilityContacts.buyingAuthorityScore,
        })
        .from(facilityContacts)
        .where(eq(facilityContacts.facilityId, String(args.facilityId)))
        .limit(50);
      return { content: { contacts: rows, count: rows.length } };
    },
  );

  // ─── db_persist_opportunity ───────────────────────────────────────────────
  add(
    {
      name: "db_persist_opportunity",
      description:
        "Persist a qualified prospect to the Opportunity Inbox and link it to this chat session. Requires a real facility_id from db_query_facilities. Returns opportunity_id.",
      input_schema: {
        type: "object",
        properties: {
          facilityId: { type: "string", description: "Real facility id (uuid) from db_query_facilities" },
          modality: { type: "string", description: "Equipment line / modality, e.g. 'mammography'" },
          verticalSlug: { type: "string" },
          readinessScore: { type: "number", description: "0.0–1.0 composite readiness" },
          summary: { type: "string", description: "1–3 sentence summary the rep sees in the Inbox" },
        },
        required: ["facilityId", "modality", "summary"],
      },
    },
    async (args) => {
      const facilityId = String(args.facilityId);
      const modality = String(args.modality);
      const summary = String(args.summary);

      // Confirm the facility exists (no write → no phantom prospect).
      const [facility] = await db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.id, facilityId))
        .limit(1);
      if (!facility) {
        return {
          content: { error: "unknown_facility", message: `No facility ${facilityId} exists.` },
          isError: true,
        };
      }

      const readiness =
        typeof args.readinessScore === "number"
          ? String(Math.max(0, Math.min(1, args.readinessScore)))
          : null;

      // opportunities has a partial unique index on (account, facility,
      // modality) for live rows — re-surfacing an existing prospect is fine.
      const inserted = await db
        .insert(opportunities)
        .values({
          accountId: ctx.accountId,
          facilityId,
          modality,
          verticalSlug: typeof args.verticalSlug === "string" ? args.verticalSlug : null,
          readinessScore: readiness,
          notes: summary,
        })
        .onConflictDoNothing()
        .returning({ id: opportunities.id });

      let opportunityId = inserted[0]?.id;
      if (!opportunityId) {
        const [existing] = await db
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(
            and(
              eq(opportunities.accountId, ctx.accountId),
              eq(opportunities.facilityId, facilityId),
              eq(opportunities.modality, modality),
            ),
          )
          .limit(1);
        opportunityId = existing?.id;
      }
      if (!opportunityId) {
        return { content: { error: "persist_failed" }, isError: true };
      }

      await db
        .insert(chatSessionProspects)
        .values({ sessionId: ctx.sessionId, opportunityId })
        .onConflictDoNothing();

      return {
        content: { opportunityId, status: "persisted" },
        prospectSurfaced: { opportunityId, summary },
      };
    },
  );

  // ─── draft_outreach ───────────────────────────────────────────────────────
  add(
    {
      name: "draft_outreach",
      description:
        "Create a DRAFT outreach message (status 'pending') for a facility. The rep must review and approve before anything is sent — this tool never sends. Returns draft_id.",
      input_schema: {
        type: "object",
        properties: {
          facilityId: { type: "string" },
          contactId: { type: "string", description: "Optional facility_contacts id" },
          subject: { type: "string" },
          body: { type: "string", description: "The drafted message text" },
        },
        required: ["facilityId", "body"],
      },
    },
    async (args) => {
      const [row] = await db
        .insert(outreachDrafts)
        .values({
          accountId: ctx.accountId,
          facilityId: String(args.facilityId),
          contactId: typeof args.contactId === "string" ? args.contactId : null,
          channel: "email",
          subject: typeof args.subject === "string" ? args.subject : null,
          body: String(args.body),
          status: "pending",
          aiModel: "prospecting-agent",
        })
        .returning({ id: outreachDrafts.id });
      return {
        content: {
          draftId: row.id,
          status: "pending",
          note: "Draft created. The rep reviews and approves it before any send — nothing was sent.",
        },
      };
    },
  );

  // ─── request_clarification ────────────────────────────────────────────────
  add(
    {
      name: "request_clarification",
      description:
        "Surface a structured clarification question to the rep when you genuinely need more context (e.g. a state without an ICP, or a modality without a buyer type). Don't use for trivial follow-ups — just ask in your reply text.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question"],
      },
    },
    async (args) => ({
      content: {
        type: "clarification_request",
        question: String(args.question),
        options: Array.isArray(args.options) ? args.options : [],
      },
    }),
  );

  return { definitions, executors };
}
