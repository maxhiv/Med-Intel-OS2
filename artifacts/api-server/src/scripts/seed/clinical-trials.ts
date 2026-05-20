/**
 * ClinicalTrials.gov bulk seed — paginated v2 API over the full corpus.
 *
 * Endpoint: https://clinicaltrials.gov/api/v2/studies
 * No auth. Each page is ≤1000 studies; full corpus ≈500K studies → ~500
 * requests. Stages into `clinical_trials_raw` (one row per NCT id) then
 * emits `clinical_trial` signals against facilities whose name token-overlaps
 * one of the study's location facilities (via the same matcher as the live
 * delta ingestor).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/seed/clinical-trials.ts \
 *     [--page-size 1000] [--max-pages 0] [--force]
 *
 * Note: this writes one source_seed_runs row for the *whole pagination loop*
 * (not one per page) because the page sequence has no persistent identity.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger";
import { startSeedRun, finishSeedRun, withProgress, parseFlags } from "./_lib";

const BASE_URL = "https://clinicaltrials.gov/api/v2/studies";
const SOURCE_NAME = "clinical_trials";

interface CtLocation { facility?: string; city?: string; state?: string; country?: string }
interface CtStudy {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: {
      overallStatus?: string;
      startDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
    };
    conditionsModule?: { conditions?: string[] };
    designModule?: { phases?: string[]; enrollmentInfo?: { count?: number } };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    contactsLocationsModule?: { locations?: CtLocation[] };
  };
}
interface CtResp { studies: CtStudy[]; nextPageToken?: string }

export async function runClinicalTrialsSeed(opts: {
  pageSize?: number;
  maxPages?: number;
  force?: boolean;
} = {}): Promise<{ rowsStaged: number; signalsInserted: number }> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 0;

  const runId = await startSeedRun({
    sourceName: SOURCE_NAME,
    fileUrl: `${BASE_URL}?pageSize=${pageSize}`,
    meta: { pageSize, maxPages },
  });

  try {
    let pageToken: string | undefined;
    let pagesFetched = 0;
    let rowsStaged = 0;

    await withProgress("clinical-trials:fetch", async (tick) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const url = new URL(BASE_URL);
        url.searchParams.set("pageSize", String(pageSize));
        url.searchParams.set("format", "json");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        // CT.gov rejects requests without a User-Agent (403). Match the
        // live ingestor's UA so rate-limit accounting is consistent.
        const res = await fetch(url.toString(), {
          headers: {
            Accept: "application/json",
            "User-Agent": process.env.CT_USER_AGENT ?? "MedIntel/1.0",
          },
        });
        if (!res.ok) {
          throw new Error(`CT.gov page fetch ${res.status}: ${res.statusText}`);
        }
        const body = (await res.json()) as CtResp;
        const studies = body.studies ?? [];
        if (studies.length === 0) break;

        rowsStaged += await flushStudies(studies);
        for (let i = 0; i < studies.length; i++) tick();
        pagesFetched++;

        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
        if (maxPages > 0 && pagesFetched >= maxPages) break;
      }
    });

    const signalsInserted = await transformCt();

    await finishSeedRun(runId, {
      status: "ok",
      rowsStaged,
      signalsInserted,
      meta: { pagesFetched },
    });
    return { rowsStaged, signalsInserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishSeedRun(runId, { status: "failed", errorMessage: msg });
    throw err;
  }
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function flushStudies(studies: CtStudy[]): Promise<number> {
  const tuples: string[] = [];
  for (const st of studies) {
    const id = st.protocolSection?.identificationModule;
    const nct = s(id?.nctId);
    if (!nct) continue;
    const status = st.protocolSection?.statusModule;
    const cond = st.protocolSection?.conditionsModule?.conditions ?? [];
    const sponsor = st.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name;
    const phase = st.protocolSection?.designModule?.phases?.[0];
    const enrollment = st.protocolSection?.designModule?.enrollmentInfo?.count;
    const locations = st.protocolSection?.contactsLocationsModule?.locations ?? [];

    const condArr =
      cond.length > 0
        ? `ARRAY[${cond.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")}]::text[]`
        : "NULL";

    tuples.push(
      `(${lit(nct)}, ${lit(s(id?.briefTitle))}, ${lit(s(status?.overallStatus))}, ` +
        `${lit(s(status?.startDateStruct?.date))}, ${lit(s(status?.completionDateStruct?.date))}, ` +
        `${condArr}, ${lit(s(phase))}, ${lit(typeof enrollment === "number" ? enrollment : null)}, ` +
        `${lit(s(sponsor))}, ${lit(locations)}, ${lit(st)})`,
    );
  }
  if (tuples.length === 0) return 0;
  await db.execute(sql.raw(`
    INSERT INTO clinical_trials_raw (
      nct_id, brief_title, overall_status, start_date, completion_date,
      conditions, phase, enrollment, sponsor_name, locations, raw_json
    ) VALUES ${tuples.join(",")}
    ON CONFLICT (nct_id) DO UPDATE SET
      brief_title     = EXCLUDED.brief_title,
      overall_status  = EXCLUDED.overall_status,
      start_date      = EXCLUDED.start_date,
      completion_date = EXCLUDED.completion_date,
      conditions      = EXCLUDED.conditions,
      phase           = EXCLUDED.phase,
      enrollment      = EXCLUDED.enrollment,
      sponsor_name    = EXCLUDED.sponsor_name,
      locations       = EXCLUDED.locations,
      raw_json        = EXCLUDED.raw_json,
      ingested_at     = now()
  `));
  return tuples.length;
}

async function transformCt(): Promise<number> {
  // Emit clinical_trial signals for facilities whose name appears in a study's
  // location list. SQL-level token overlap (Postgres trigram) on the facility
  // name is fast enough at this scale; for live deltas we use the JS matcher
  // in services/clinicalTrialsIngestor.ts.
  const res = await db.execute<{ id: string }>(sql`
    WITH study_loc AS (
      SELECT ctr.nct_id,
             ctr.start_date,
             ctr.overall_status,
             ctr.phase,
             ctr.sponsor_name,
             loc->>'facility' AS loc_facility,
             loc->>'state'    AS loc_state,
             'ctgov:' || ctr.nct_id AS sval
        FROM clinical_trials_raw ctr,
             jsonb_array_elements(COALESCE(ctr.locations, '[]'::jsonb)) AS loc
       WHERE ctr.overall_status IN ('RECRUITING','ACTIVE_NOT_RECRUITING','ENROLLING_BY_INVITATION')
         AND ctr.start_date > now() - interval '24 months'
    )
    INSERT INTO purchase_signals (
      facility_id, signal_type, signal_value, confidence, source, metadata, is_active
    )
    SELECT f.id,
           'clinical_trial'::signal_type,
           sl.sval,
           60,
           'clinicaltrials_gov',
           jsonb_build_object(
             'nct_id', sl.nct_id,
             'status', sl.overall_status,
             'phase',  sl.phase,
             'sponsor', sl.sponsor_name,
             'location', sl.loc_facility,
             'start_date', sl.start_date
           ),
           true
      FROM study_loc sl
      JOIN facilities f
        ON (f.state IS NULL OR sl.loc_state IS NULL OR f.state = sl.loc_state)
       AND f.name % sl.loc_facility   -- pg_trgm similarity
     WHERE NOT EXISTS (
       SELECT 1 FROM purchase_signals ps
        WHERE ps.facility_id = f.id
          AND ps.signal_type = 'clinical_trial'
          AND ps.signal_value = sl.sval
     )
    RETURNING id
  `);
  return res.rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  runClinicalTrialsSeed({
    pageSize: typeof flags["page-size"] === "string" ? Number(flags["page-size"]) : undefined,
    maxPages: typeof flags["max-pages"] === "string" ? Number(flags["max-pages"]) : undefined,
    force: flags.force === true,
  })
    .then((r) => {
      logger.info(r, "clinical-trials: seed done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "clinical-trials: seed failed");
      process.exit(1);
    });
}
