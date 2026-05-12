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
 * (`CON_FEED_URL_IL`, `CON_FEED_URL_NY`, `CON_FEED_URL_FL`,
 * `CON_FEED_URL_NC`, `CON_FEED_URL_NC_DECISIONS`, `CON_FEED_URL_GA`,
 * `CON_FEED_URL_MI`, `CON_FEED_URL_OH`) so ops can swap portals without
 * a code change when state IT teams move things around.
 */
import { and, eq, ilike, or } from "drizzle-orm";
import {
  db,
  facilities,
  conFilings,
  purchaseSignals,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  candidateTokens,
  pickBestFacility,
  DEFAULT_MATCH_THRESHOLD,
  type FacilityCandidate,
} from "./facilityNameMatch";

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

/**
 * Ordered modality matchers. `priority` ranks how specific / clinically
 * valuable the signal is — when a filing mentions multiple modalities (e.g.
 * "PET/CT scanner", "SPECT/CT camera", "MRI + ultrasound suite") we want the
 * more specialised one to win rather than whichever keyword happens to appear
 * first in the list. Higher = more specific.
 */
const MODALITY_KEYWORDS: { re: RegExp; modality: string; priority: number }[] = [
  { re: /\bPET\b|positron emission/i, modality: "PET", priority: 10 },
  { re: /\bSPECT\b/i, modality: "SPECT", priority: 10 },
  { re: /linear accelerator|\bLINAC\b/i, modality: "LINAC", priority: 9 },
  { re: /\bMRI\b|magnetic resonance/i, modality: "MRI", priority: 8 },
  { re: /\bCT\b|computed tomograph/i, modality: "CT", priority: 7 },
  { re: /\bmammograph/i, modality: "MAMMO", priority: 6 },
  { re: /cardiac cath/i, modality: "CATH", priority: 5 },
  { re: /ultrasound/i, modality: "US", priority: 3 },
  { re: /\bx-?ray\b/i, modality: "XRAY", priority: 2 },
];

export function inferModality(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  let best: { modality: string; priority: number } | undefined;
  for (const { re, modality, priority } of MODALITY_KEYWORDS) {
    if (re.test(text) && (!best || priority > best.priority)) {
      best = { modality, priority };
    }
  }
  return best?.modality;
}

export function looksApproved(status: string | undefined | null): boolean {
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
export function parseRssItems(xml: string): {
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
export function extractApplicant(title: string): string {
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
    // North Carolina — the DHSR CON Section publishes individual project
    // PDFs under stable index pages. The HTML index adapter scrapes those
    // links (filename = applicant + status) and returns a RawFiling per PDF.
    ncDhsrAdapter(),
    // Georgia — DCH publishes a department-wide announcements RSS feed
    // that includes CON-related notices. The downstream pipeline filters by
    // facility-name match so non-CON items are simply ignored.
    rssAdapter(
      "GA",
      "https://dch.georgia.gov/rss.xml",
      "CON_FEED_URL_GA",
    ),
    // Michigan — LARA / Bureau of Community and Health Systems. No stable
    // public feed exists today; the env override is the primary path. The
    // default points at LARA's news index so the adapter still issues a
    // request (returns 0 items until ops sets CON_FEED_URL_MI).
    rssAdapter(
      "MI",
      "https://www.michigan.gov/lara/news-releases/rss",
      "CON_FEED_URL_MI",
    ),
    // Ohio — ODH CON program. As with MI, no stable public feed; included
    // so ops can drop in a URL via CON_FEED_URL_OH without a code change.
    rssAdapter(
      "OH",
      "https://odh.ohio.gov/news/rss",
      "CON_FEED_URL_OH",
    ),
  ];
}

// ---------------------------------------------------------------------------
// NC DHSR adapter
// ---------------------------------------------------------------------------

/**
 * North Carolina DHSR Certificate-of-Need section publishes each filing as a
 * PDF under stable monthly index pages, e.g.
 *   /dhsr/coneed/reviews/2026/jan/5014 Guilford Clearview Surgical Center No Review.pdf
 *   /dhsr/coneed/decisions/2025/aug/decisions/Wake J-12649-25 ... Approval.pdf
 *
 * The filename is structured "<projectId> <county> <applicant> [<oldId>] <status>".
 * We scrape the two index pages and emit one RawFiling per linked PDF.
 */
function ncDhsrAdapter(): StateAdapter {
  return {
    state: "NC",
    async fetch() {
      const reviewsUrl =
        process.env.CON_FEED_URL_NC ??
        "https://info.ncdhhs.gov/dhsr/coneed/reviews/index.html";
      const decisionsUrl =
        process.env.CON_FEED_URL_NC_DECISIONS ??
        "https://info.ncdhhs.gov/dhsr/coneed/decisions/index.html";

      const out: RawFiling[] = [];
      const seen = new Set<string>();
      for (const url of [reviewsUrl, decisionsUrl]) {
        const html = await fetchText(url);
        if (!html) continue;
        const base = new URL(url);
        const hrefRe = /href=["']([^"']+\.pdf)["']/gi;
        let m: RegExpExecArray | null;
        while ((m = hrefRe.exec(html)) !== null) {
          const raw = m[1];
          // Skip "findings" PDFs — they pair with a sibling decision PDF that
          // already covers the same applicant + project, so deduping by URL
          // alone would still create two filings per project.
          if (/\/findings\//i.test(raw)) continue;
          let absolute: string;
          try {
            absolute = new URL(raw, base).toString();
          } catch {
            continue;
          }
          if (seen.has(absolute)) continue;
          seen.add(absolute);

          const filename = decodeURIComponent(
            absolute.split("/").pop() ?? "",
          ).replace(/\.pdf$/i, "");
          const parsed = parseNcFilename(filename);
          if (!parsed.applicant) continue;

          const isDecisions = /\/decisions\//i.test(absolute);
          const approved = /approv/i.test(parsed.status ?? "");
          out.push({
            state: "NC",
            filingUrl: absolute,
            applicantName: parsed.applicant,
            rawStatus: parsed.status ?? (isDecisions ? "decision" : "review"),
            approved: isDecisions ? approved : false,
            modality: inferModality(parsed.applicant + " " + (parsed.status ?? "")),
            notes: filename.slice(0, 1000),
          });
        }
      }
      return out;
    },
  };
}

/**
 * Parse a NC DHSR CON filename into applicant + status. Filenames look like:
 *   "5014 Guilford Clearview Surgical Center No Review-CORRECTED"
 *   "Wake J-12649-25 Wake County Rehabilitation Hospital 210730 Approval"
 *   "Forsyth G-12640-25 Novant Health Kernersville Medical Center 060620 Approval"
 *
 * Strategy: pull the trailing status keyword (Approval/Disapproval/Exemption/
 * No Review/Withdrawal/etc), strip the leading project-id and county tokens,
 * and treat what remains as the applicant.
 */
function parseNcFilename(name: string): {
  applicant?: string;
  status?: string;
} {
  const cleaned = name.replace(/\s+/g, " ").trim();
  const statusRe =
    /\b(Approval|Disapproval|Exemption|No Review|Withdrawal|Findings|CORRECTED)\b.*$/i;
  const statusMatch = statusRe.exec(cleaned);
  const status = statusMatch?.[0]?.replace(/-CORRECTED$/i, "").trim();
  let head = statusMatch ? cleaned.slice(0, statusMatch.index) : cleaned;
  // Strip project-id prefixes like "5014 ", "J-12649-25 ", "O-12613-25 ".
  head = head
    .replace(/^[A-Z]?-?\d{3,5}(-\d{2})?\s+/i, "")
    .replace(/^\d{3,5}\s+/, "");
  // Strip leading NC county name (single capitalised word followed by space).
  head = head.replace(
    /^(Alamance|Alexander|Alleghany|Anson|Ashe|Avery|Beaufort|Bertie|Bladen|Brunswick|Buncombe|Burke|Cabarrus|Caldwell|Camden|Carteret|Caswell|Catawba|Chatham|Cherokee|Chowan|Clay|Cleveland|Columbus|Craven|Cumberland|Currituck|Dare|Davidson|Davie|Duplin|Durham|Edgecombe|Forsyth|Franklin|Gaston|Gates|Graham|Granville|Greene|Guilford|Halifax|Harnett|Haywood|Henderson|Hertford|Hoke|Hyde|Iredell|Jackson|Johnston|Jones|Lee|Lenoir|Lincoln|Macon|Madison|Martin|McDowell|Mecklenburg|Mitchell|Montgomery|Moore|Nash|New Hanover|Northampton|Onslow|Orange|Pamlico|Pasquotank|Pender|Perquimans|Person|Pitt|Polk|Randolph|Richmond|Robeson|Rockingham|Rowan|Rutherford|Sampson|Scotland|Stanly|Stokes|Surry|Swain|Transylvania|Tyrrell|Union|Vance|Wake|Warren|Washington|Watauga|Wayne|Wilkes|Wilson|Yadkin|Yancey)\s+/i,
    "",
  );
  // Strip a trailing legacy facility id (run of 5–7 digits at end of head).
  head = head.replace(/\s+\d{5,7}\s*$/, "").trim();
  if (head.length < 4) return { status };
  return { applicant: head.slice(0, 250), status };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Maximum candidate facilities pulled from the DB before fuzzy scoring. */
const CANDIDATE_POOL_LIMIT = 50;

/**
 * Try to resolve a tracked facility for a CON filing.
 *
 * Resolution order:
 *   1. Exact NPI match (strongest signal, no state filter needed).
 *   2. Token-based candidate pool from `name`, `doing_business_as` and
 *      `system_name` within the same state, then fuzzy-scored with
 *      `pickBestFacility`. The applicant string is split on `d/b/a`,
 *      `on behalf of`, etc. so parent-system filings still resolve.
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

  // 2. Build a small candidate pool keyed on shared meaningful tokens across
  // any of name / DBA / system_name. We use the longest tokens first so noisy
  // 4-letter tokens don't blow the pool past the limit.
  const tokens = candidateTokens(applicant).slice(0, 6);
  if (tokens.length === 0) return null;

  const tokenConds = tokens.flatMap((t) => {
    const pattern = `%${t}%`;
    return [
      ilike(facilities.name, pattern),
      ilike(facilities.doingBusinessAs, pattern),
      ilike(facilities.systemName, pattern),
    ];
  });

  const rows = await db
    .select({
      id: facilities.id,
      name: facilities.name,
      doingBusinessAs: facilities.doingBusinessAs,
      systemName: facilities.systemName,
    })
    .from(facilities)
    .where(and(eq(facilities.state, state), or(...tokenConds)))
    .limit(CANDIDATE_POOL_LIMIT);

  if (rows.length === 0) return null;

  const candidates: FacilityCandidate[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    doingBusinessAs: r.doingBusinessAs,
    systemName: r.systemName,
  }));
  const best = pickBestFacility(applicant, candidates, {
    threshold: DEFAULT_MATCH_THRESHOLD,
  });
  if (!best) return null;
  logger.debug(
    {
      applicant,
      state,
      facilityId: best.facility.id,
      score: Number(best.score.toFixed(3)),
      via: best.matchedField,
      pool: rows.length,
    },
    "con applicant matched to facility",
  );
  return { id: best.facility.id };
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
