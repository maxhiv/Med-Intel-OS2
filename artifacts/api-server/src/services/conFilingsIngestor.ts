/**
 * State Certificate-of-Need filings ingestor.
 *
 * Polls a small set of state CON portals, dedupes the resulting filings by
 * `(state, filing_url)`, writes each new filing into `con_filings`, and emits
 * a matching `purchase_signals` row of type `con_filed` or `con_approved`
 * when we can resolve the applicant to a tracked facility.
 *
 * State adapters are intentionally thin and defensive: each one fetches a
 * single public endpoint, parses the response, and returns a normalised
 * `RawFiling[]`. A failure in one state does not block the others.
 *
 * Endpoints can be overridden per-state via env vars
 * (`CON_FEED_URL_IL`, `CON_FEED_URL_NY`, `CON_FEED_URL_FL`) so ops can swap
 * portals without a code change when state IT teams move things around.
 */
import { and, eq, ilike, or } from "drizzle-orm";
import {
  db,
  facilities,
  conFilings,
  purchaseSignals,
} from "@workspace/db";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawFiling {
  state: string; // 2-letter code
  filingUrl: string; // unique per-portal URL or stable id-as-url
  applicantName: string;
  filingDate?: Date;
  decisionDate?: Date;
  /** Free-text status string from the source. */
  rawStatus?: string;
  /** True if the source indicates the application was approved. */
  approved?: boolean;
  equipmentType?: string;
  modality?: string;
  requestedAmount?: number;
  approvedAmount?: number;
  notes?: string;
  /** Optional NPI of the applicant facility, when the source provides it. */
  npi?: string;
}

interface StateAdapter {
  state: string;
  /** Best-effort fetch; never throws — returns [] on any failure. */
  fetch: () => Promise<RawFiling[]>;
}

export interface ConIngestResult {
  adaptersRun: number;
  filingsFetched: number;
  filingsInserted: number;
  signalsInserted: number;
  facilitiesLinked: number;
  errors: number;
  perState: Record<
    string,
    { fetched: number; inserted: number; signals: number; errors: number }
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODALITY_KEYWORDS: { re: RegExp; modality: string }[] = [
  { re: /\bMRI\b|magnetic resonance/i, modality: "MRI" },
  { re: /\bCT\b|computed tomograph/i, modality: "CT" },
  { re: /\bPET\b|positron emission/i, modality: "PET" },
  { re: /\bSPECT\b/i, modality: "SPECT" },
  { re: /linear accelerator|\bLINAC\b/i, modality: "LINAC" },
  { re: /\bmammograph/i, modality: "MAMMO" },
  { re: /ultrasound/i, modality: "US" },
  { re: /\bx-?ray\b/i, modality: "XRAY" },
  { re: /cardiac cath/i, modality: "CATH" },
];

function inferModality(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  for (const { re, modality } of MODALITY_KEYWORDS) {
    if (re.test(text)) return modality;
  }
  return undefined;
}

function looksApproved(status: string | undefined | null): boolean {
  if (!status) return false;
  return /approv|grant(ed)?|issued/i.test(status);
}

function safeDate(s: string | undefined | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Strip HTML tags + decode common entities from RSS descriptions. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tiny RSS 2.0 / Atom item extractor. Good enough for portal feeds. */
function parseRssItems(xml: string): {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
}[] {
  const items: ReturnType<typeof parseRssItems> = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[2];
    const title = stripHtml(
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "",
    );
    // RSS uses <link>url</link>; Atom uses <link href="url"/>
    let link = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(body)?.[1]?.trim() ?? "";
    if (!link) {
      link = /<link[^>]*href=["']([^"']+)["']/i.exec(body)?.[1] ?? "";
    }
    const pubDate =
      /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(body)?.[1]?.trim() ??
      /<updated[^>]*>([\s\S]*?)<\/updated>/i.exec(body)?.[1]?.trim() ??
      /<published[^>]*>([\s\S]*?)<\/published>/i.exec(body)?.[1]?.trim();
    const description = stripHtml(
      /<description[^>]*>([\s\S]*?)<\/description>/i.exec(body)?.[1] ??
        /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(body)?.[1] ??
        "",
    );
    if (title && link) {
      items.push({ title, link, pubDate, description });
    }
  }
  return items;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "MedIntel/1.0 (+con-ingestor)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.8, */*;q=0.5",
      },
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "con feed fetch non-2xx");
      return null;
    }
    return await res.text();
  } catch (err) {
    logger.warn({ err, url }, "con feed fetch threw");
    return null;
  }
}

// ---------------------------------------------------------------------------
// State adapters
// ---------------------------------------------------------------------------

/**
 * Generic RSS/Atom adapter. Many state portals expose a "recent filings" or
 * "board agenda" feed; we treat each item as a filing and infer status from
 * the title/description text.
 */
function rssAdapter(state: string, defaultUrl: string, envKey: string): StateAdapter {
  return {
    state,
    async fetch() {
      const url = process.env[envKey] ?? defaultUrl;
      const xml = await fetchText(url);
      if (!xml) return [];
      const items = parseRssItems(xml);
      return items.map<RawFiling>((it) => {
        const text = `${it.title} ${it.description ?? ""}`;
        const approved = looksApproved(text);
        return {
          state,
          filingUrl: it.link,
          applicantName: extractApplicant(it.title),
          filingDate: safeDate(it.pubDate),
          rawStatus: approved ? "approved" : "filed",
          approved,
          modality: inferModality(text),
          notes: it.description?.slice(0, 1000),
        };
      });
    },
  };
}

/**
 * Best-effort applicant-name extraction from an RSS title. State portals tend
 * to title items like "Saint Mary's Hospital — CON #24-001 — MRI replacement",
 * so we take the chunk before the first separator.
 */
function extractApplicant(title: string): string {
  const cut = title.split(/\s[—–-]\s|:\s/, 1)[0] ?? title;
  return cut.trim().slice(0, 250);
}

/**
 * Socrata JSON adapter for NY (health.data.ny.gov publishes a number of
 * facility datasets through Socrata's `/resource/<id>.json` API). The dataset
 * id is configurable; the default is a sensible placeholder. Records are
 * mapped via a flexible shape — only the fields we care about are pulled.
 */
function socrataAdapter(opts: {
  state: string;
  defaultUrl: string;
  envKey: string;
}): StateAdapter {
  return {
    state: opts.state,
    async fetch() {
      const url = process.env[opts.envKey] ?? opts.defaultUrl;
      const text = await fetchText(url);
      if (!text) return [];
      let rows: unknown;
      try {
        rows = JSON.parse(text);
      } catch (err) {
        logger.warn({ err, url }, "socrata payload not JSON");
        return [];
      }
      if (!Array.isArray(rows)) return [];
      return rows.flatMap<RawFiling>((r) => {
        if (!r || typeof r !== "object") return [];
        const row = r as Record<string, unknown>;
        const get = (k: string): string | undefined => {
          const v = row[k];
          return typeof v === "string" && v.trim() ? v.trim() : undefined;
        };
        const num = (k: string): number | undefined => {
          const v = row[k];
          if (typeof v === "number") return v;
          if (typeof v === "string" && v.trim() !== "") {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
          }
          return undefined;
        };
        const applicant =
          get("applicant_name") ??
          get("facility_name") ??
          get("applicant") ??
          get("name");
        const link =
          get("filing_url") ??
          get("url") ??
          get("application_url") ??
          (get("application_number")
            ? `nyse-con://${get("application_number")}`
            : undefined);
        if (!applicant || !link) return [];
        const status = get("status") ?? get("application_status");
        const approved = looksApproved(status);
        const text = `${applicant} ${get("project_description") ?? ""} ${get("project_title") ?? ""}`;
        return [
          {
            state: opts.state,
            filingUrl: link,
            applicantName: applicant,
            filingDate:
              safeDate(get("filing_date")) ?? safeDate(get("date_received")),
            decisionDate:
              safeDate(get("decision_date")) ?? safeDate(get("approval_date")),
            rawStatus: status,
            approved,
            equipmentType: get("equipment_type") ?? get("project_type"),
            modality: inferModality(text),
            requestedAmount: num("requested_amount") ?? num("project_cost"),
            approvedAmount: num("approved_amount"),
            notes: get("project_description"),
            npi: get("npi") ?? get("applicant_npi") ?? get("facility_npi"),
          },
        ];
      });
    },
  };
}

export function buildAdapters(): StateAdapter[] {
  // Defaults point at known public landing/feed URLs. They may 404 over time
  // — the adapter logs and returns [] rather than throwing — and can be
  // overridden via env vars without redeploying.
  return [
    rssAdapter(
      "IL",
      "https://hfsrb.illinois.gov/about/news.xml",
      "CON_FEED_URL_IL",
    ),
    socrataAdapter({
      state: "NY",
      defaultUrl:
        "https://health.data.ny.gov/resource/qq4x-7f7t.json?$limit=200&$order=filing_date%20DESC",
      envKey: "CON_FEED_URL_NY",
    }),
    rssAdapter(
      "FL",
      "https://ahca.myflorida.com/MCHQ/CON_FA/feed.xml",
      "CON_FEED_URL_FL",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Try to resolve a tracked facility for a CON filing. Prefers NPI when the
 * source provides one (exact unique match), and falls back to a
 * case-insensitive name match scoped to the filing's state.
 */
async function findFacility(
  applicant: string,
  state: string,
  npi?: string,
): Promise<{ id: string } | null> {
  // 1. Exact NPI match — strongest signal, no state filter needed.
  if (npi && /^\d{10}$/.test(npi)) {
    const [byNpi] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.npi, npi))
      .limit(1);
    if (byNpi) return byNpi;
  }

  // 2. Name + state heuristic with light corporate-suffix stripping. Also
  // checks `doing_business_as` so DBA-named filings still resolve.
  const cleaned = applicant
    .replace(/\b(inc|llc|llp|pa|pc|pllc|corp|corporation|co|the)\b\.?/gi, "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 4) return null;
  const pattern = `%${cleaned}%`;
  const [hit] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      and(
        eq(facilities.state, state),
        or(
          ilike(facilities.name, pattern),
          ilike(facilities.doingBusinessAs, pattern),
        ),
      ),
    )
    .limit(1);
  return hit ?? null;
}

function toDateOnly(d: Date | undefined): string | undefined {
  if (!d) return undefined;
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function ingestConFilings(opts: {
  adapters?: StateAdapter[];
} = {}): Promise<ConIngestResult> {
  const adapters = opts.adapters ?? buildAdapters();
  const result: ConIngestResult = {
    adaptersRun: 0,
    filingsFetched: 0,
    filingsInserted: 0,
    signalsInserted: 0,
    facilitiesLinked: 0,
    errors: 0,
    perState: {},
  };

  for (const adapter of adapters) {
    result.adaptersRun += 1;
    const stateBucket = (result.perState[adapter.state] ??= {
      fetched: 0,
      inserted: 0,
      signals: 0,
      errors: 0,
    });

    let raws: RawFiling[] = [];
    try {
      raws = await adapter.fetch();
    } catch (err) {
      logger.warn({ err, state: adapter.state }, "con adapter threw");
      result.errors += 1;
      stateBucket.errors += 1;
      continue;
    }

    stateBucket.fetched = raws.length;
    result.filingsFetched += raws.length;

    for (const raw of raws) {
      if (!raw.filingUrl || !raw.applicantName) continue;

      // Idempotency: skip if we've already stored this (state, url) pair.
      const [existing] = await db
        .select({ id: conFilings.id, facilityId: conFilings.facilityId })
        .from(conFilings)
        .where(
          and(
            eq(conFilings.state, raw.state),
            eq(conFilings.filingUrl, raw.filingUrl),
          ),
        )
        .limit(1);
      if (existing) continue;

      const facility = await findFacility(raw.applicantName, raw.state, raw.npi);
      if (facility) result.facilitiesLinked += 1;

      const [inserted] = await db
        .insert(conFilings)
        .values({
          facilityId: facility?.id ?? null,
          state: raw.state,
          filingDate: toDateOnly(raw.filingDate),
          decisionDate: toDateOnly(raw.decisionDate),
          equipmentType: raw.equipmentType,
          modality: raw.modality,
          requestedAmount: raw.requestedAmount,
          approvedAmount: raw.approvedAmount,
          status: raw.rawStatus,
          applicantName: raw.applicantName,
          filingUrl: raw.filingUrl,
          notes: raw.notes,
        })
        .returning({ id: conFilings.id });
      stateBucket.inserted += 1;
      result.filingsInserted += 1;

      // Signal emission requires a linked facility (the FK is NOT NULL).
      if (!facility || !inserted) continue;

      const signalType = raw.approved ? "con_approved" : "con_filed";
      const [sigExists] = await db
        .select({ id: purchaseSignals.id })
        .from(purchaseSignals)
        .where(
          and(
            eq(purchaseSignals.facilityId, facility.id),
            eq(purchaseSignals.signalType, signalType),
            eq(purchaseSignals.signalValue, raw.filingUrl),
          ),
        )
        .limit(1);
      if (sigExists) continue;

      await db.insert(purchaseSignals).values({
        facilityId: facility.id,
        signalType,
        signalValue: raw.filingUrl,
        confidence: raw.approved ? 90 : 75,
        source: "con_filing",
        sourceId: inserted.id,
        isActive: true,
      });
      stateBucket.signals += 1;
      result.signalsInserted += 1;

      // Touch facility freshness so downstream scheduling notices the update.
      await db
        .update(facilities)
        .set({ updatedAt: new Date() })
        .where(eq(facilities.id, facility.id));
    }
  }

  logger.info(result, "con filings ingest complete");
  return result;
}
