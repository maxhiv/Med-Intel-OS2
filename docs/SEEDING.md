# MedIntel OS — Bulk Seeding Playbook

This document describes the one-time bulk-seed process that establishes the
facility universe and back-loads every signal source. After seeding, the
existing live ingestors (`refresh-all-sources.ts` / national-ingest cron)
keep the system fresh with deltas.

## Storage layout

Three layers of storage hold seed state. Operators only manage layer 1.

```
┌───────────────────────────────────────────────────────────────────────┐
│ 1. Downloaded files (operator-managed)                                │
│    $SEED_DATA_DIR  default: <repo-root>/.seed-data/  (gitignored)     │
│                                                                       │
│    .seed-data/                                                        │
│      ├── nppes/             npi.zip + extracted CSV (~11 GB)          │
│      ├── hcris/             Hospital_Provider_Cost_Report.csv         │
│      ├── fda/                                                         │
│      │   ├── 510k/          partition ZIPs from openFDA               │
│      │   ├── classification/                                          │
│      │   ├── recall/                                                  │
│      │   └── maude/                                                   │
│      ├── clinical-trials/   (API pagination — no files cached)        │
│      ├── nih-grants/        NIH_Projects_FY{2020..2024}.csv           │
│      ├── usa-spending/      bulk-download ZIP from api.usaspending    │
│      ├── cms-provider/      one CSV per registered dataset            │
│      ├── sec-edgar/         master_{YYYY}_Q{N}.idx files              │
│      └── medicare-utilization/  MUP_PHY_*.csv                         │
└───────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────────┐
│ 2. Staging tables (managed by seed scripts)                           │
│    Postgres — one *_raw table per source, truncated+reloaded per seed │
│                                                                       │
│    hcris_raw                fda_510k_raw                              │
│    fda_classification_raw   fda_recall_raw                            │
│    fda_maude_raw            clinical_trials_raw                       │
│    nih_grants_raw           usa_spending_raw                          │
│    cms_provider_raw         medicare_utilization_raw                  │
│    sec_edgar_filings_raw    irs_990_raw                               │
└───────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────────┐
│ 3. Canonical tables (already in production)                           │
│                                                                       │
│    facilities               purchase_signals                          │
│    facility_contacts        equipment_records                         │
│    equipment_age_evidence   con_filings                               │
│    opportunities            …                                         │
│                                                                       │
│    Each seed transforms its staging table into one or more of these   │
│    via idempotent UPSERTs keyed on stable natural identifiers (NPI,   │
│    CCN, EIN, NCT id, K-number, accession).                            │
└───────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────────┐
│ 4. Run audit (`source_seed_runs`)                                     │
│                                                                       │
│    Every seed step records start/finish, file_url, file_sha256,       │
│    file_bytes, rows_staged, rows_upserted, signals_inserted, status,  │
│    error_message. Re-running the orchestrator skips steps whose       │
│    latest row matches (file_sha256, status='ok').                     │
│                                                                       │
│    Inspect:                                                           │
│      SELECT source_name, status, rows_staged, rows_upserted,          │
│             signals_inserted, finished_at                              │
│        FROM source_seed_runs                                          │
│       ORDER BY started_at DESC LIMIT 50;                              │
└───────────────────────────────────────────────────────────────────────┘
```

## One-time setup

1. **Apply schema.** From `lib/db`:
   ```bash
   pnpm --filter @workspace/db push
   bash lib/db/src/scripts/v2_install.sh   # runs v2_*.sql + seed_freshness.sql
   ```
2. **Choose a seed directory** that has enough free space (~50 GB headroom):
   ```bash
   export SEED_DATA_DIR=/var/lib/medintel-seed
   mkdir -p "$SEED_DATA_DIR"
   ```
   Default if unset: `<repo>/.seed-data/` (gitignored).
3. **Required env vars** for specific sources:
   - `SEC_USER_AGENT="medintel-os contact@example.com"` — SEC rejects
     requests without a contact email in the UA.
   - `MEDICARE_UTIL_URL` — operator pastes the latest annual file URL from
     data.cms.gov when seeding utilization (this URL changes yearly).
   - `NPPES_ZIP_PATH` — defaults to `$SEED_DATA_DIR/nppes/npi.zip`. Download
     the latest "Full Replacement Monthly NPI File" from
     <https://download.cms.gov/nppes/NPI_Files.html> and drop it there.

## Running the seed

### Full bootstrap (4–8 hours, mostly bound by download speed)

```bash
pnpm seed:all                        # all sources in dependency order
pnpm seed:all --only hcris           # one source
pnpm seed:all --skip sec_edgar,nppes # everything except these
pnpm seed:all --force                # re-run even if sha256 matches a prior 'ok'
pnpm seed:all --dry-run              # print the plan, don't execute
```

### Per-source

```bash
pnpm --filter @workspace/api-server seed:hcris
pnpm --filter @workspace/api-server seed:fda --endpoints 510k,recall
pnpm --filter @workspace/api-server seed:clinical-trials --max-pages 50  # test mode
pnpm --filter @workspace/api-server seed:nih-grants --years 2024,2023
pnpm --filter @workspace/api-server seed:usa-spending --start-date 2024-01-01
pnpm --filter @workspace/api-server seed:cms-provider
pnpm --filter @workspace/api-server seed:sec-edgar --quarters 4
pnpm --filter @workspace/api-server seed:medicare-util --url <CMS_URL>
```

### Resumability

Each seed step records its own `source_seed_runs` row. If `seed:all` fails
mid-way, re-run it — the orchestrator continues past failed steps (rather
than aborting) and individual sources skip files whose sha256 matches a
prior `status='ok'` row. To force a re-run despite a sha256 match, pass
`--force`.

## Dependency order

Signals key on `facility_id`, so the universe must exist first:

```
1. nppes         → facilities (NPI universe)
2. irs_bmf       → reference data (EIN ↔ name)
3. irs_990       → financials + officer contacts   needs irs_bmf
4. cms_provider  → beds, ownership, ratings        needs nppes
5. hcris         → depreciation spikes             needs nppes
6. fda_bulk      → adverse_event signals (recall + MAUDE)
7. clinical_trials → clinical_trial signals        needs nppes
8. nih_grants    → nih_grant signals               needs nppes
9. usa_spending  → aip_infra_spend signals         needs nppes
10. sec_edgar    → filings index (no signals yet)
11. medicare_util→ high_utilization signals        needs nppes
```

## Going forward (delta mode)

Once the bootstrap completes, the existing live ingestors take over via
the national-ingest cron (`refresh-all-sources.ts` / per-source cron in
`cron/index.ts`). Those run nightly and pull only:

- New NPIs since the last NPPES weekly update.
- New CON filings since the last RSS poll.
- New 510k clearances and recalls since the last decision_date.
- New clinical trials since the last status_lastUpdateDate.
- etc.

No re-seeding needed unless you want to refresh a year's worth of data
in one shot (e.g. a brand-new HCRIS fiscal-year file lands).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `function unnest(jsonb) does not exist` | Old schema | Apply PR #10 fixes; v2_install.sh |
| `SEC_USER_AGENT env var is required` | EDGAR will reject | `export SEC_USER_AGENT="medintel <email>"` |
| HCRIS row count is 0 | `data.cms.gov` URL changed | Pass `--url <new>` |
| ClinicalTrials.gov returns 429 | Rate-limited | Reduce `--page-size` (default 1000) |
| USA Spending poll timeout | Bulk job > 60 min | Re-run; the submit endpoint is idempotent on identical filters |
| NPPES python script `psycopg2` error | Missing dep | `pip3 install psycopg2-binary` |

## Inspecting run state

```sql
-- last seed status per source
SELECT DISTINCT ON (source_name)
       source_name, status, rows_staged, rows_upserted,
       signals_inserted, started_at, finished_at, error_message
  FROM source_seed_runs
 ORDER BY source_name, started_at DESC;

-- failed runs in the last 24h
SELECT source_name, error_message, started_at
  FROM source_seed_runs
 WHERE status = 'failed'
   AND started_at > now() - interval '24 hours';

-- raw → canonical conversion rate per source
SELECT source_name,
       SUM(rows_staged)    AS staged,
       SUM(rows_upserted)  AS upserted,
       SUM(signals_inserted) AS signals
  FROM source_seed_runs
 WHERE status = 'ok'
 GROUP BY source_name
 ORDER BY signals DESC;
```
