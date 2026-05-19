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

## Territory planner

`/territories` (web) lets a rep build a filtered list of qualified
prospects, save it as a named territory, and re-run it quarterly against
fresh CMS data.

- **Filters:** states · ZIP codes · facility types · ownership (PE / REIT /
  chain / holding / for-profit) · financial size (min beds / assets / net
  patient revenue) · buying-cycle (recent CHOW, AIP infra spend, CMMI in
  state, PSI-11 outlier) · service mix (outpatient revenue, discharges) ·
  min composite score · free-text name search.
- **Views:** table (sortable by score / name / beds / revenue) and map
  (MapLibre, OSM tiles, pins colored by score, popup with key signals).
- **CSV export** of any saved territory's evaluation.
- **Sell-side variant:** flipping a saved territory to `view_kind=sell_side`
  auto-applies distress filters and surfaces the seller-side CHOW, net
  income YoY decline, cash YoY decline, and active-acquisition-market
  signals. A facility must hit at least one distress signal to surface.

Persistence lives in two new tables (Drizzle schema in
[`lib/db/src/schema/app.ts`](../lib/db/src/schema/app.ts)):
- `territories(id, account_id, view_kind, name, filter JSONB,
   equipment_line_slug, is_shared, …)`
- `equipment_line_profiles(id, slug, name, account_id NULL, is_system,
   rubric JSONB)`

API endpoints (in
[`routes/territories.ts`](../artifacts/api-server/src/routes/territories.ts)
and [`routes/equipmentLines.ts`](../artifacts/api-server/src/routes/equipmentLines.ts)):

| Method | Path | Description |
|---|---|---|
| GET    | `/api/territories[?viewKind=…]` | List the account's saved territories |
| POST   | `/api/territories`              | Create a territory |
| GET    | `/api/territories/:id`          | Get a saved territory |
| PUT    | `/api/territories/:id`          | Update name/filter/lens |
| DELETE | `/api/territories/:id`          | Delete |
| GET    | `/api/territories/:id/facilities` | Evaluate, with `?equipmentLine=&sortBy=&limit=&offset=` overrides |
| POST   | `/api/territories/preview`      | Evaluate without saving |
| GET    | `/api/equipment-lines`          | List system + account-customized profiles |
| GET    | `/api/equipment-lines/:slug`    | Get a single profile |
| PUT    | `/api/equipment-lines/:slug`    | Create/update an account override |
| DELETE | `/api/equipment-lines/:slug`    | Delete an account override (system profiles are immutable) |

## Equipment-line profiles

Six system profiles are seeded at server startup
([`equipmentLineService.ts → seedSystemEquipmentLineProfiles`](../artifacts/api-server/src/services/equipmentLineService.ts)):

| Slug | Best fit |
|---|---|
| `imaging` | Outpatient-heavy hospitals + imaging centers with discharge volume |
| `surgical` | Hospitals + ASCs with strong surgical case volume |
| `monitoring` | Acute hospitals with ICU intensity; PSI-11 outliers light up |
| `sterilization` | Larger acute facilities + ASCs |
| `endoscopy` | Outpatient-heavy mix; ASCs win this lane |
| `lab` | Hospitals + community clinics with patient volume + ACO/CMMI |

Each rubric weights facility type, HCRIS metrics (beds, revenue,
discharges), and signal flags (chow_recent, pe_takeover, …). Account
admins can override any slug via `PUT /api/equipment-lines/:slug`.

## MapLibre map

[`components/territory-map.tsx`](../artifacts/web/src/components/territory-map.tsx)
renders pins at `facilities.lat,lng` using OSM raster tiles (no API key).
Pins are colored by activation score:

- **Red** ≥ 70 (hot)
- **Orange** 50–69 (warm)
- **Amber** 30–49 (qualified)
- **Slate** < 30

For higher-volume use, swap the style to a vector source (MapTiler / Stadia)
with your own token in the `OSM_STYLE` constant.

## Crosswalks

[`medintel_os_extensions.sql`](./medintel_os_extensions.sql) is an additive
extension to `medintel_os_schema.sql`. Run it whenever you receive these
optional crosswalk files:

- **ACO Provider TIN roster.** Adds `dim_aco.tin` + `parent_organization`,
  and a `stage_aco_tin_roster` staging surface. Once loaded, the
  intelligence endpoint matches ACO participation via EIN ↔ TIN first,
  falling back to fuzzy ASM-roster name match.
- **CCN ↔ HCUP `hosp_id` crosswalk** (e.g. from the AHA Annual Survey).
  Adds `ref_ccn_hosp_id`. When populated, both the intelligence endpoint
  and the daily signal scorer use it for PSI-11; when empty, both fall
  back gracefully to the previous numeric-CCN best-effort path.

Load example (replace `your_*.csv` with your file):

```sql
\copy medintel.stage_aco_tin_roster FROM 'your_aco_tin_roster.csv' WITH (FORMAT csv, HEADER true)
-- The UPDATE inside medintel_os_extensions.sql copies these into dim_aco.tin.

\copy medintel.ref_ccn_hosp_id (ccn, hosp_id, source) FROM 'your_ccn_hospid.csv' WITH (FORMAT csv, HEADER true)
```

## What this PR does NOT do (yet)

- **OpenAPI codegen for the intelligence + territory endpoints.** The
  committed `lib/api-client-react/src/generated/` was produced by a
  pre-8.5.2 orval that emitted `Omit<UseQueryOptions, 'queryKey'>`; orval
  8.5.2 now emits the full `UseQueryOptions`, which breaks ~15 existing
  call sites (`useGetDashboardSummary({ refetchInterval: ... })` etc.).
  Untangling that is a pre-existing maintenance gap unrelated to this PR;
  until it's done, the new endpoints are reached via manual `customFetch`
  hooks in `hooks/use-facility-intelligence.ts` and `hooks/use-territory.ts`.
- **Drive-time radius filter.** The filter shape reserves a slot for it;
  the planner UI currently only supports state + ZIP geography. Hooking
  in OSRM or Mapbox Directions is a follow-up.
- **`@tanstack/react-table`.** The territory tables are vanilla `<table>`
  elements with sortable column headers in `useState`; swapping in
  TanStack Table is a cosmetic upgrade with no API surface change.

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
