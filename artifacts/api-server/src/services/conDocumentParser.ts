/**
 * CON document parser.
 *
 * State CON portals publish each filing as a PDF whose *filename* carries only
 * an applicant name and a status keyword. The document itself holds the data
 * that actually matters: the project id, the facility's county, the state
 * facility id (NC DHSR "FID #"), the project description, the approved capital
 * expenditure, and the appeal deadline.
 *
 * This module fetches a filing PDF and extracts those structured fields. It is
 * tuned for the North Carolina DHSR decision/review documents — the only state
 * adapter that emits PDF URLs today — but the label-driven extractor degrades
 * gracefully on any other layout (every field simply comes back undefined).
 *
 * Everything here is fail-soft: a network error, a non-PDF response, or a
 * malformed document yields `null` rather than throwing, so a bad document can
 * never block the ingest run.
 */
import { PDFParse } from "pdf-parse";
import { logger } from "../lib/logger";

const FETCH_TIMEOUT_MS = 30_000;
/** Hard cap so a pathological PDF can't exhaust memory. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface ParsedConDocument {
  projectId?: string;
  facilityName?: string;
  projectDescription?: string;
  county?: string;
  /** State facility identifier (NC DHSR "FID #"). */
  stateFacilityId?: string;
  approvedAmount?: number;
  requestedAmount?: number;
  decisionDate?: Date;
  appealDeadline?: Date;
  applicantContact?: string;
  modality?: string;
  equipmentType?: string;
  /** True/false when the document clearly states an outcome; undefined otherwise. */
  approved?: boolean;
  /** Length of the extracted text — a cheap "did we actually read anything" check. */
  textLength: number;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchPdf(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MedIntel/1.0 (+con-document-parser)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "con document fetch non-2xx");
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_PDF_BYTES) {
      logger.warn({ url, bytes: buf.byteLength }, "con document size out of bounds");
      return null;
    }
    // PDFs start with "%PDF". Anything else (an HTML error page, say) is junk.
    if (buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46) {
      logger.warn({ url }, "con document is not a PDF");
      return null;
    }
    return buf;
  } catch (err) {
    logger.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      "con document fetch threw",
    );
    return null;
  }
}

/** Fetch a filing PDF and extract its structured fields. Null on any failure. */
export async function extractConDocument(url: string): Promise<ParsedConDocument | null> {
  const bytes = await fetchPdf(url);
  if (!bytes) return null;

  let text: string;
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    text = result.text ?? "";
  } catch (err) {
    logger.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      "con document text extraction failed",
    );
    return null;
  } finally {
    await parser.destroy().catch(() => {});
  }

  if (!text.trim()) {
    logger.warn({ url }, "con document yielded no text (likely a scanned image)");
    return { textLength: 0 };
  }
  return parseConDocumentText(text);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Labels on the NC DHSR decision/review documents, in no particular order.
 * The extractor finds each label, then takes everything up to the *next*
 * label as the value — robust to the value sitting on the same line or
 * wrapping onto the next.
 */
const FIELD_LABELS: { key: string; re: RegExp }[] = [
  { key: "projectId", re: /Project\s*I\.?\s*D\.?\s*#?\s*:/i },
  { key: "facility", re: /\bFacility\s*:/i },
  { key: "projectDescription", re: /Project\s*Description\s*:/i },
  { key: "county", re: /\bCounty\s*:/i },
  { key: "fid", re: /\bF\.?\s*I\.?\s*D\.?\s*#?\s*:/i },
  { key: "approvedAmount", re: /Approved\s*Capital\s*Expenditure\s*:/i },
  {
    key: "requestedAmount",
    re: /(?:Proposed|Requested|Estimated|Total)\s*Capital\s*(?:Expenditure|Cost)\s*:/i,
  },
  { key: "conditions", re: /Conditions?\s*of\s*Approval\s*:/i },
  { key: "timetable", re: /Approved\s*Timetable\s*:/i },
  { key: "appeal", re: /Last\s*Date\s*to\s*Appeal\s*:/i },
  { key: "findings", re: /Required\s*State\s*Agency\s*Findings\s*:/i },
];

/** Modality keyword scan, most-specific first. */
const MODALITIES: { re: RegExp; modality: string }[] = [
  { re: /\bPET(?:\/CT)?\b|positron emission/i, modality: "PET" },
  { re: /\bSPECT(?:\/CT)?\b/i, modality: "SPECT" },
  { re: /linear accelerator|\bLINAC\b/i, modality: "LINAC" },
  { re: /\bMRI\b|magnetic resonance/i, modality: "MRI" },
  { re: /\bCT\b|computed tomograph/i, modality: "CT" },
  { re: /\bmammograph/i, modality: "MAMMO" },
  { re: /cardiac cath|angiograph/i, modality: "CATH" },
  { re: /ultrasound/i, modality: "US" },
  { re: /\bx-?ray\b/i, modality: "XRAY" },
];

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Split the document into label → value pairs. */
function extractLabeledFields(text: string): Map<string, string> {
  const hits: { key: string; start: number; valueStart: number }[] = [];
  for (const { key, re } of FIELD_LABELS) {
    const m = re.exec(text);
    if (m) hits.push({ key, start: m.index, valueStart: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start);

  const fields = new Map<string, string>();
  for (let i = 0; i < hits.length; i += 1) {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    const value = collapse(text.slice(hits[i].valueStart, end));
    if (value) fields.set(hits[i].key, value);
  }
  return fields;
}

function parseAmount(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /\$?\s*([\d,]{2,})(?:\.\d+)?/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const m = /([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/.exec(s);
  if (!m) return undefined;
  const d = new Date(m[1].replace(/\./g, ""));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function inferModality(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const { re, modality } of MODALITIES) {
    if (re.test(text)) return modality;
  }
  return undefined;
}

/** Pull a short equipment phrase out of a project description. */
function inferEquipmentType(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const m =
    /\b(?:acquire|add|replace|purchase|develop|relocate|install)\s+(?:one|two|three|a|an|\d+)?\s*([A-Za-z][A-Za-z0-9 /-]{2,55}?)\s+(?:pursuant|to\b|for\b|in\b|at\b|by\b|\.|$)/i.exec(
      description,
    );
  if (m) return collapse(m[1]);
  return undefined;
}

/** Parse already-extracted document text into structured fields. Pure. */
export function parseConDocumentText(text: string): ParsedConDocument {
  const fields = extractLabeledFields(text);

  const projectIdRaw = fields.get("projectId");
  const projectId = projectIdRaw
    ? (/[A-Z]?-?\d{3,5}-\d{2}\b/.exec(projectIdRaw)?.[0] ?? collapse(projectIdRaw).slice(0, 40))
    : undefined;

  const facilityName = fields.get("facility")?.slice(0, 250);
  const projectDescription = fields.get("projectDescription")?.slice(0, 1000);

  let county = fields.get("county");
  if (county) {
    county = collapse(county).replace(/\s+county$/i, "").slice(0, 80) || undefined;
  }

  const fidRaw = fields.get("fid");
  const stateFacilityId = fidRaw ? (/\d{3,10}/.exec(fidRaw)?.[0] ?? undefined) : undefined;

  const approvedAmount = parseAmount(fields.get("approvedAmount"));
  const requestedAmount = parseAmount(fields.get("requestedAmount"));
  const appealDeadline = parseDate(fields.get("appeal"));

  // The decision letter date sits next to "RESPONSE REQUIRED" near the top.
  const decisionDate = parseDate(
    /RESPONSE\s+REQUIRED\s*([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i.exec(text)?.[1],
  );

  // Applicant contact: the addressee block between the response date and the
  // "Conditional Approval"/"Project ID" heading. Best-effort.
  let applicantContact: string | undefined;
  const contactMatch =
    /RESPONSE\s+REQUIRED\s*[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}\s+([\s\S]{4,200}?)\s*(?:Conditional\s+Approval|Project\s*I\.?\s*D|Disapproval\b|Re\s*:)/i.exec(
      text,
    );
  if (contactMatch) {
    applicantContact = collapse(contactMatch[1]).slice(0, 200) || undefined;
  }

  // Outcome: trust an explicit heading; leave undefined if the doc is unclear.
  let approved: boolean | undefined;
  const outcome = /\b(Conditional\s+Approval|Disapproval|Withdrawal|Approval)\b/i.exec(text);
  if (outcome) {
    approved = !/^Dis|^With/i.test(outcome[1]);
  }

  const modality = inferModality(projectDescription) ?? inferModality(text);
  const equipmentType = inferEquipmentType(projectDescription);

  return {
    projectId,
    facilityName,
    projectDescription,
    county,
    stateFacilityId,
    approvedAmount,
    requestedAmount,
    decisionDate,
    appealDeadline,
    applicantContact,
    modality,
    equipmentType,
    approved,
    textLength: text.length,
  };
}
