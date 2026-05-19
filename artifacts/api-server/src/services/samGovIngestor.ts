/**
 * SAM.gov Federal Procurement Ingestor
 *
 * Monitors federal RFP opportunities for medical imaging equipment (NAICS
 * 334517 / 334510) and emits `rfp_posted` purchase signals.
 *
 * Also extracts named points of contact (poc_first_name, poc_last_name,
 * poc_title, poc_email, poc_phone) from each opportunity and upserts them
 * into `facility_contacts` (dataSource: "sam_gov") following the same
 * idempotent pattern used by nppesIngestor.ts.
 *
 * Requires env var: SAM_GOV_API_KEY (free registration at api.sam.gov).
 * If not set, logs a warning and returns zero counts — never fails hard.
 *
 * Docs: https://open.gsa.gov/api/opportunities-api/
 */
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db, facilities, facilityContacts, purchaseSignals } from "@workspace/db";
import { logger } from "../lib/logger";
import { enrichContact } from "./enrichment";

const BASE_URL = "https://api.sam.gov/opportunities/v2/search";
const NAICS_CODES = ["334517", "334510"];
const DELAY_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SamIngestResult {
  signalsInserted: number;
  contactsUpserted: number;
  errors: number;
}

interface SamPointOfContact {
  type?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  title?: string;
  fax?: string;
}

interface SamOpportunity {
  noticeId?: string;
  title?: string;
  postedDate?: string;
  responseDeadLine?: string;
  organizationName?: string;
  placeOfPerformanceCityName?: string;
  placeOfPerformanceState?: { code?: string };
  naicsCode?: string;
  description?: string;
  uiLink?: string;
  pointOfContact?: SamPointOfContact[];
}

interface SamResponse {
  opportunitiesData?: SamOpportunity[];
  totalRecords?: number;
}

async function matchFacility(orgName: string | undefined): Promise<string | null> {
  if (!orgName) return null;
  const name = orgName.trim();
  if (!name) return null;
  const [match] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      or(
        ilike(facilities.name, `%${name}%`),
        ilike(facilities.doingBusinessAs, `%${name}%`),
        ilike(facilities.systemName, `%${name}%`),
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

/**
 * Split a full name string into { firstName, lastName }.
 * Splits on the last space so "Mary Jane Watson" → { firstName: "Mary Jane", lastName: "Watson" }.
 * Returns null strings when the input is empty.
 */
function splitFullName(fullName: string | undefined): { firstName: string | null; lastName: string | null } {
  const name = fullName?.trim();
  if (!name) return { firstName: null, lastName: null };
  const lastSpace = name.lastIndexOf(" ");
  if (lastSpace === -1) return { firstName: null, lastName: name };
  return {
    firstName: name.slice(0, lastSpace),
    lastName: name.slice(lastSpace + 1),
  };
}

async function upsertSamContact(
  facilityId: string,
  poc: SamPointOfContact,
  result: SamIngestResult,
): Promise<void> {
  const { firstName, lastName } = splitFullName(poc.fullName);
  if (!firstName && !lastName) return;

  const email = poc.email?.trim() || null;
  const phone = poc.phone?.trim() || null;
  const title = poc.title?.trim() || null;

  const [existing] = await db
    .select({ id: facilityContacts.id })
    .from(facilityContacts)
    .where(
      and(
        eq(facilityContacts.facilityId, facilityId),
        firstName ? eq(facilityContacts.firstName, firstName) : isNull(facilityContacts.firstName),
        lastName  ? eq(facilityContacts.lastName,  lastName)  : isNull(facilityContacts.lastName),
      ),
    )
    .limit(1);
  if (existing) return;

  const [inserted] = await db.insert(facilityContacts).values({
    facilityId,
    firstName,
    lastName,
    title,
    email,
    phone,
    department: null,
    dataSource: "sam_gov",
    confidenceScore: 60,
    buyingAuthorityScore: 40,
  }).returning({ id: facilityContacts.id });

  result.contactsUpserted += 1;

  if (inserted) {
    try {
      await enrichContact(inserted.id);
    } catch (err) {
      logger.warn({ err, contactId: inserted.id, facilityId }, "sam_gov contact enrichment failed");
    }
  }
}

export async function ingestSamGov(
  opts: { limit?: number } = {},
): Promise<SamIngestResult> {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    logger.warn("SAM_GOV_API_KEY not set — skipping SAM.gov ingest");
    return { signalsInserted: 0, contactsUpserted: 0, errors: 0 };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const result: SamIngestResult = { signalsInserted: 0, contactsUpserted: 0, errors: 0 };

  for (const naics of NAICS_CODES) {
    const params = new URLSearchParams({
      api_key: apiKey,
      naicsCode: naics,
      typeOfSetAsideDescription: "",
      ntype: "o",
      status: "Active",
      limit: String(limit),
      offset: "0",
    });

    try {
      const res = await fetch(`${BASE_URL}?${params}`, {
        headers: { Accept: "application/json", "User-Agent": "MedIntel/1.0" },
      });
      if (!res.ok) {
        logger.warn({ status: res.status, naics }, "sam.gov API error");
        result.errors += 1;
        continue;
      }
      const body = (await res.json()) as SamResponse;
      const opps = body.opportunitiesData ?? [];

      for (const opp of opps) {
        if (!opp.noticeId) continue;

        const signalValue = `sam:${opp.noticeId}`;
        const [exists] = await db
          .select({ id: purchaseSignals.id })
          .from(purchaseSignals)
          .where(
            and(
              eq(purchaseSignals.signalType, "rfp_posted"),
              eq(purchaseSignals.signalValue, signalValue),
            ),
          )
          .limit(1);
        const facilityId = await matchFacility(opp.organizationName);

        if (!exists && facilityId) {
          await db.insert(purchaseSignals).values({
            facilityId,
            signalType: "rfp_posted",
            signalValue,
            confidence: 80,
            source: "sam_gov",
            isActive: true,
          });
          result.signalsInserted += 1;
        }

        // Extract points of contact and upsert into facility_contacts.
        if (facilityId) {
          for (const poc of opp.pointOfContact ?? []) {
            await upsertSamContact(facilityId, poc, result);
          }
        }

        await sleep(DELAY_MS);
      }
    } catch (err) {
      logger.warn({ err, naics }, "sam.gov ingest error");
      result.errors += 1;
    }

    await sleep(DELAY_MS);
  }

  logger.info(result, "sam_gov ingest complete");
  return result;
}
