/**
 * medintelTools — proprietary capital-equipment-broker tools.
 *
 * Phase 2A ships these as STUBS. Each returns a structured
 * `{ status: "not_implemented", phase }` response so the agent knows the
 * capability isn't live yet and falls back to MCP / database tools. Phases
 * 2–6 replace each stub with the real implementation behind the same name —
 * the chat surface picks up the capability with zero agent changes.
 */
import type { AgentToolDefinition, ToolRegistry } from "./types";

interface StubDef {
  def: AgentToolDefinition;
  phase: number;
  fallback: string;
}

const STUBS: StubDef[] = [
  {
    phase: 2,
    fallback: "Use claims-analytics or web-intelligence MCP tools for related signals.",
    def: {
      name: "medintel_search_con_filings",
      description:
        "Search state Certificate of Need (CON) filings — applications, awards, denials with applicant facility + equipment category. [Phase 2]",
      input_schema: {
        type: "object",
        properties: {
          state: { type: "string", description: "Two-letter state code" },
          equipmentCategory: { type: "string" },
          dateFrom: { type: "string" },
        },
        required: ["state"],
      },
    },
  },
  {
    phase: 3,
    fallback: "Use db_query_equipment for known equipment records.",
    def: {
      name: "medintel_radiation_registry_lookup",
      description:
        "Look up state radiation registry permits (mammography, fluoroscopy, CT, linac) with license expiry + disclosed equipment. [Phase 3]",
      input_schema: {
        type: "object",
        properties: { state: { type: "string" }, modality: { type: "string" } },
        required: ["state"],
      },
    },
  },
  {
    phase: 2,
    fallback: "Use the openFDA MCP tools if available.",
    def: {
      name: "medintel_fda_maude_match",
      description:
        "Match FDA MAUDE adverse-event / recall data against a manufacturer + model. [Phase 2]",
      input_schema: {
        type: "object",
        properties: { manufacturer: { type: "string" }, model: { type: "string" } },
        required: ["manufacturer", "model"],
      },
    },
  },
  {
    phase: 3,
    fallback: "Reason from equipment install year if known.",
    def: {
      name: "medintel_eol_catalog_lookup",
      description:
        "Manufacturer end-of-life catalog: EOL date, end-of-service date, successor model for an equipment model. [Phase 1 seed + Phase 3]",
      input_schema: {
        type: "object",
        properties: { manufacturer: { type: "string" }, model: { type: "string" } },
        required: ["manufacturer", "model"],
      },
    },
  },
  {
    phase: 4,
    fallback: "Use hospital-quality MCP tools for accreditation hints.",
    def: {
      name: "medintel_accreditation_expiry",
      description:
        "Modality-specific accreditation expiry (ACR / IAC / AAAHC / AAAASF / AAHA) for a facility. [Phase 4]",
      input_schema: {
        type: "object",
        properties: { facilityId: { type: "string" }, modality: { type: "string" } },
        required: ["facilityId"],
      },
    },
  },
  {
    phase: 4,
    fallback: "Use workforce-analytics MCP tools for staffing signals.",
    def: {
      name: "medintel_job_posting_velocity",
      description:
        "Job-posting velocity (Adzuna / Jooble / USAJobs) as a throughput / expansion signal for a facility. [Phase 4]",
      input_schema: {
        type: "object",
        properties: { facilityId: { type: "string" } },
        required: ["facilityId"],
      },
    },
  },
  {
    phase: 3,
    fallback: "Use db_query_equipment.",
    def: {
      name: "medintel_equipment_age_inference",
      description:
        "Equipment-age inference engine: weighted multi-source install-year estimate + confidence. [Phase 3]",
      input_schema: {
        type: "object",
        properties: { facilityId: { type: "string" }, modality: { type: "string" } },
        required: ["facilityId"],
      },
    },
  },
  {
    phase: 2,
    fallback: "Use financial-intelligence MCP tools.",
    def: {
      name: "medintel_emma_bond_lookup",
      description:
        "MSRB EMMA municipal-bond official statements — capital-project bond issuances tied to a facility. [Phase 2]",
      input_schema: {
        type: "object",
        properties: { facilityName: { type: "string" }, state: { type: "string" } },
        required: ["facilityName"],
      },
    },
  },
  {
    phase: 5,
    fallback: "Rank prospects yourself from the gathered signals; do not invent a score.",
    def: {
      name: "medintel_score_opportunities",
      description:
        "Proprietary opportunity-scoring engine — readiness/urgency/fit composite. Always use this rather than inventing a score. [Phase 5]",
      input_schema: {
        type: "object",
        properties: {
          facilityIds: { type: "array", items: { type: "string" } },
          modality: { type: "string" },
        },
        required: ["facilityIds"],
      },
    },
  },
];

export function buildMedIntelTools(): ToolRegistry {
  const definitions = STUBS.map((s) => s.def);
  const executors = new Map(
    STUBS.map((s) => [
      s.def.name,
      async () => ({
        content: {
          status: "not_implemented",
          phase: s.phase,
          message: `${s.def.name} ships in Phase ${s.phase} of the v2.0 roadmap.`,
          fallback: s.fallback,
        },
      }),
    ]),
  );
  return { definitions, executors };
}
