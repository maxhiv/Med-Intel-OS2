# Medintel OS — App Integration

This doc describes how the `medintel.*` warehouse plugs into the Express API
and React web app. The warehouse itself is documented in
[`README.md`](./README.md), and its schema lives in
[`medintel_os_schema.sql`](./medintel_os_schema.sql).

## TL;DR

1. Load the warehouse (`medintel_os_schema.sql` + `medintel_os_load.sql`).
2. Run [`medintel_os_grants.sql`](./medintel_os_grants.sql) once so the
   `app_rls` role can `SELECT` from the schema.
3. `pnpm --filter @workspace/db run push` to sync the new `signal_type`
   enum values (see [`enums.ts`](../lib/db/src/schema/enums.ts)).
4. Set `VITE_MEDINTEL_OS_MODE=true` in the web app's env to hide the
   outbound-marketing nav surfaces.
5. The new endpoint and signals are live without any further setup.

## Backend wiring

### Read-only Drizzle bindings

[`lib/db/src/schema/medintel.ts`](../lib/db/src/schema/medintel.ts) declares
`pgSchema("medintel")` and types the 15 warehouse tables the app reads from.
Only the columns actually queried are listed; the warehouse has more on disk.
No insert/update logic — writes belong to the SQL load script.

### Intelligence endpoint

`GET /api/facilities/:id/intelligence` (in
[`routes/facilities.ts`](../artifacts/api-server/src/routes/facilities.ts))
returns the assembled hospital card. Implementation in
[`services/medintelRepo.ts`](../artifacts/api-server/src/services/medintelRepo.ts).

Match strategy:
1. CCN — exact match against `medintel.dim_facility.ccn`.
2. NPI — `medintel.bridge_npi_enrollment.npi` cross-walk.

The response shape (see `FacilityIntelligence` in `medintelRepo.ts`) covers:
- PECOS identity, primary/secondary NPIs, all addresses on file
- Ownership tree with PE/REIT/chain/holding/MSO flags
- Recent CHOW transaction + full history
- HCRIS cost report (latest + up to 10 prior years)
- Service area (top ZIPs by patient charges)
- AHRQ PSI-11 best-effort match
- ACO + AIP spend participation (via ASM NPI cohort)
- CMMI Innovation Center models active in the facility's state
- Chain summary (when an owner is flagged chain-home-office)

### Signal scorer

[`services/medintelSignalScorer.ts`](../artifacts/api-server/src/services/medintelSignalScorer.ts)
walks the linkable subset of `facilities` (those with a CCN and/or a
10-digit NPI), resolves to PECOS enrollments, and emits one
`purchase_signals` row per matched rule. Idempotent via `signal_value` —
the stable source identifier — so re-runs don't duplicate rows.

| signal_type | Tier | Weight | Trigger |
|---|---|---|---|
| `chow_recent`       | 1 | 35 | CHOW with `effective_date` within last 18 months |
| `pe_takeover`       | 1 | 30 | `fact_ownership.is_private_equity = TRUE` |
| `reit_takeover`     | 1 | 28 | `fact_ownership.is_reit = TRUE` |
| `aip_infra_spend`   | 1 | 25 | ACO AIP spend line tagged infra / HIT / capital / equipment |
| `chain_acquisition` | 2 | 12 | Chain-home-office owner controls 5+ facilities |
| `psi11_outlier`     | 2 | 15 | PSI-11 rate above national average |
| `cmmi_state_launch` | 3 |  5 | CMMI model active in facility's state |

The 02:45 daily cron in
[`cron/index.ts`](../artifacts/api-server/src/cron/index.ts) runs the scan
right before the 03:00 composite score recompute picks the new rows up.

### Updated signal scoring

[`services/signalScorer.ts`](../artifacts/api-server/src/services/signalScorer.ts)
got the new signal types added to its `TIER1_SIGNALS` / `TIER2_SIGNALS`
sets and `WEIGHTS` table. Composite facility scores will start reflecting
medintel signals automatically on the next recompute tick.

## Frontend wiring

### Intelligence tab on the facility detail page

[`pages/facilities/detail.tsx`](../artifacts/web/src/pages/facilities/detail.tsx)
gained a new "Intelligence" tab as the default landing tab. It mounts
[`pages/facilities/intelligence-tab.tsx`](../artifacts/web/src/pages/facilities/intelligence-tab.tsx)
which consumes the new endpoint via
[`hooks/use-facility-intelligence.ts`](../artifacts/web/src/hooks/use-facility-intelligence.ts).

The tab itself nests six sub-tabs:
- Ownership (chain summary + full owner list with PE/REIT/Chain badges)
- Financials (HCRIS — beds, revenue, margins, charity care, assets)
- CHOW (recent + history with buyer/seller/date)
- Catchment (top 10 ZIPs by patient charges)
- Programs (ACO + AIP spend, CMMI models in state)
- Quality (AHRQ PSI-11 rate vs. national avg)

### `VITE_MEDINTEL_OS_MODE` feature flag

Setting `VITE_MEDINTEL_OS_MODE=true` in the web env hides the Outreach
navigation group (Contacts, Campaigns, Sequences, Drafts, Batches) per the
Medintel OS product brief's "no automated outreach" stance. The routes
themselves still resolve so direct links don't 404 — only the nav
surfaces are suppressed. Reports stay accessible under their own group.

The API server routes for those features are untouched. Disabling the
flag instantly restores the original LeadStack-style UX.

## What this PR does NOT do (yet)

The Medintel OS brief calls for several capabilities still on the roadmap:

- Territory planning UI (state / metro / ZIP / drive-time filters with
  saved-list persistence).
- Equipment-line targeting profiles (imaging / surgical / monitoring /
  sterilization / endoscopy / lab) with per-line scoring.
- Sell-side prospecting view (declining HCRIS trend + seller-side CHOW).
- MapLibre territory map.
- OpenAPI codegen for the new intelligence endpoint (the hook talks to the
  endpoint directly for now via `customFetch`).
- ASM-to-ACO matching is currently a fuzzy name match on the participant's
  `organization_legal_name`; a proper TIN/EIN crosswalk would tighten it.
- PSI-11 keys on HCUP `hosp_id`, not CCN; the rule does a best-effort
  numeric match. A CCN ↔ hosp_id crosswalk is needed for full coverage.

## Operational notes

- **Cron schedule.** Medintel scan runs 02:45 America/Chicago daily. Set
  `DISABLE_CRON=true` to skip during tests.
- **Idempotency.** Re-running the scan inserts no duplicate rows. To force
  fresh emission of a rule, mark the existing rows inactive
  (`UPDATE purchase_signals SET is_active = false WHERE source='medintel_warehouse' AND signal_type='chow_recent';`).
- **Tenant isolation.** Warehouse data has no `account_id` so it's not
  scoped by tenant. The intelligence endpoint enforces that the requesting
  account owns the *app-side* facility before hitting the warehouse.
- **Permissions.** If you see `permission denied for schema medintel` in
  API logs, re-run [`medintel_os_grants.sql`](./medintel_os_grants.sql).
