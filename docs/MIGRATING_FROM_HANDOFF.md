# Migrating from the v2.0 Handoff Package

This repo previously received a "MedIntel OS v2.0 Handoff Package" archive
(`medintel-v2-handoff.zip`). The strategic content in that archive is
excellent — and it lives, verbatim, under [`docs/medintel/`](./medintel/).
The **mechanical assumptions** in the handoff package, however, target a
different codebase shape than what we ship today, and its `install.sh`
would have created parallel, dead directories alongside the real ones.

This document is the translation key: what we kept, what we adapted, and
what we skipped. Every phase of v2.0 work in this repo references back to
the strategic doc and to this translation table.

---

## TL;DR

| Handoff says… | This repo does… |
|---|---|
| `apps/api/src/services/…` | `artifacts/api-server/src/services/…` |
| `apps/web/src/…` | `artifacts/web/src/…` |
| `database/migrations/*.sql` (raw, forward-only) | `lib/db/src/migrations/` (Drizzle-managed, snapshot-based) |
| Plain JS, ESM, `pool.query(…)` | TypeScript + Drizzle ORM, `withRLS()` for tenant transactions |
| `facility_id BIGINT REFERENCES facilities(id)` | `facility_id UUID REFERENCES facilities(id)` |
| `npm run migrate` | `pnpm --filter @workspace/db run push` |
| `CLAUDE.md` overwrite | `docs/medintel/` adoption; `replit.md` untouched |
| Run `install.sh` against the repo | Do not — see "Why install.sh was not run" below |

## Why `install.sh` was not run

The handoff's `install.sh`:

1. Would create `apps/` and `database/migrations/` at repo root — neither
   path is wired into our build, esbuild config, or Drizzle config. Those
   would be dead files.
2. Would copy `.js` service skeletons next to our `.ts` services without
   converting them; TypeScript build would not pick them up, and Vite
   would not bundle them.
3. Assumes `facility_id BIGINT` in every FK; **every** new table's foreign
   key against `facilities(id)` (our UUID PK) would fail to apply.
4. Would overwrite `CLAUDE.md` at the repo root. We don't have one (the
   project conventions live in `replit.md` and the strategic content
   under `docs/medintel/`), so the overwrite would create a new top-level
   file claiming to be the contract — confusing the project's source of
   truth.
5. Would drop a top-level `CHANGELOG.md` template that conflicts with the
   PR-driven changelog flow we already use.

The content that *was* worth pulling in (strategic plan, glossary,
vertical playbooks, source catalog, coding conventions, testing strategy)
was copied manually under `docs/medintel/` instead, so the install script
was never executed.

---

## Schema reconciliation table

The handoff proposes seven new migrations (007–013). Here is how each one
maps onto what's already in the repo, and how we'll adapt it.

### Migration 007 — Equipment inventory expansion

| Handoff change | Our approach |
|---|---|
| `ALTER TABLE equipment_records ADD COLUMN confidence_score…` | **Adopt as Drizzle column adds** in Phase B (`equipment_records.confidenceScore`, `manufacturerEolDate`, `sourceCount`, `firstSeenAt`, `lastVerifiedAt`, `contradicted`, `stateRegistryId`, `fdaListingNumber`). UUID FKs only. |
| `CREATE TABLE equipment_source_citations` | **New table, Phase B** with `equipment_record_id UUID` (not BIGINT). |

### Migration 008 — Capital trigger engine

| Handoff change | Our approach |
|---|---|
| `CREATE TYPE trigger_category AS ENUM (…)` | **Skip.** We already have `signal_type` enum in `lib/db/src/schema/enums.ts` covering the same space (`chow_recent`, `pe_takeover`, `reit_takeover`, `aip_infra_spend`, `cmmi_state_launch`, `psi11_outlier`, `chain_acquisition` were added in PR #7). New trigger categories needed by Phase E (`con_filing`, `bond_issuance`, `hcris_depreciation`, `manufacturer_eol`, `accreditation_expiry`, `leadership_change`, `usda_loan`, `hrsa_grant`, `chna_gap`) will be appended to the existing enum, not duplicated in a separate type. |
| `CREATE TABLE capital_triggers (…)` | **Skip.** This is `purchase_signals` in our schema. Same shape: facility, signal type, signal value, confidence, source, detected_at, expires_at. We add columns to `purchase_signals` if more fields are needed (e.g. `dollar_amount`, `modality`). |
| `CREATE VIEW v_facility_buying_readiness` | **Adopt verbatim** as a Drizzle SQL migration — joins our `facilities` to `purchase_signals` with the same readiness-score math. |

### Migration 009 — Equipment-age inference

| Handoff change | Our approach |
|---|---|
| `CREATE TABLE equipment_age_evidence` | **Adopt as new Drizzle table, Phase D.** UUID FKs. |
| `CREATE TABLE manufacturer_eol_catalog` | **Adopt as new Drizzle table, Phase B.** Seeded with the ~25-row starter catalog. |
| `CREATE VIEW v_equipment_age_inferred` | **Adopt verbatim** as a Drizzle SQL migration in Phase D. |

### Migration 010 — Behavioral signals

| Handoff change | Our approach |
|---|---|
| `CREATE TABLE behavioral_signals` | **Skip.** Same overlap with `purchase_signals` as Migration 008. |
| `CREATE TABLE job_postings` | **Adopt as new Drizzle table** (in Phase D or E) — workforce_signals (v1) is shape-aggregated; job_postings would track individual posts with modality NER tagging. |
| `CREATE TABLE accreditation_records` | **Skip.** We already have the `accreditations` table from v1. Use the existing one; if a column is missing, add it via ALTER. |

### Migration 011 — Decision-maker graph expanded

| Handoff change | Our approach |
|---|---|
| `CREATE TYPE buyer_role AS ENUM` | **Adopt** — `lib/db/src/schema/enums.ts` gets a new `buyerRoleEnum`. |
| `ALTER TABLE facility_contacts ADD buyer_role, modality_authority, years_in_role, started_role_at, verification_status, last_verified_at` | **Adopt** — Drizzle column additions in Phase E. |
| `CREATE TABLE contact_verification_log` | **Skip.** We have `contactValidationLog` from v1, same purpose. |
| `CREATE TABLE opportunities (… RLS …)` | **Adopt as new Drizzle table, Phase E.** UUID-keyed. RLS policy via `withRLS` plus a Drizzle SQL migration emitting the policy. |

### Migration 012 — Vertical modules

| Handoff change | Our approach |
|---|---|
| `CREATE TABLE vertical_modules` | **Adopt as new Drizzle table, Phase C.** Seeded with the 5 verticals: imaging_center, orthopedic, asc, rural_hospital, veterinary. |
| `CREATE TABLE facility_vertical_map` | **Adopt as new Drizzle table, Phase C.** |
| Relationship to existing `equipment_line_profiles` | The two stay distinct: **verticals describe the customer** (imaging center, rural hospital, …); **equipment lines describe the product the rep sells** (imaging, surgical, monitoring, …). A new `equipment_line_profiles.vertical_slug` field will bridge them in Phase C. |

### Migration 013 — Confidence + validation

| Handoff change | Our approach |
|---|---|
| `CREATE TABLE intelligence_claims` | **Adopt as new Drizzle table, Phase B.** `entity_table TEXT`, `entity_id UUID` (not BIGINT). |
| `CREATE FUNCTION compute_claim_confidence(…)` | **Adopt verbatim** as a Drizzle SQL migration in Phase B. Identical PL/pgSQL — 180-day half-life decay, two-source-minimum verification logic. |
| Reference table `source_weights` | **Adopt** as a Drizzle table, Phase B; seeded with the 35-row canonical catalog from `database/seeds/03_source_weights.sql`. |

---

## Service-layer reconciliation

| Handoff (`apps/api/src/services/…`) | This repo (`artifacts/api-server/src/services/…`) |
|---|---|
| `confidence/ClaimRegistry.js` | `confidence/claimRegistry.ts` — typed Drizzle adapter |
| `confidence/ConfidenceScorer.js` | `confidence/confidenceScorer.ts` |
| `confidence/ContradictionDetector.js` | `confidence/contradictionDetector.ts` (Phase B nightly cron) |
| `equipment_age/EquipmentAgeInferenceOrchestrator.js` | `equipmentAge/equipmentAgeInferenceOrchestrator.ts` (Phase D) |
| `equipment_age/state_registries/{TexasRadiationRegistry, FloridaRadiationRegistry, …}.js` | `equipmentAge/stateRegistries/*.ts` — staging-table-driven adapters, no live scraping in v2 |
| `equipment_age/manufacturer_eol/*EOL.js` (per OEM) | `equipmentAge/manufacturerEolMatcher.ts` — single matcher driven by `manufacturer_eol_catalog` rows; no per-OEM scrapers in v2 |
| `triggers/con/{FloridaCONScraper, IllinoisCONScraper, …}.js` | Already covered by existing `conFilingsIngestor.ts`. We extend that, do not duplicate. |
| `triggers/bond/EMMABondIngestor.js` | Phase E follow-up — out of scope for the current 5-phase plan. |
| `triggers/hcris/HCRISCostReportParser.js` | Already covered by existing `hcrisIngestor.ts`. |
| `triggers/form990/Schedule990DParser.js` | Already covered by existing `propublica990Ingestor.ts` + `import990Runner.ts`. |
| `triggers/fda/MAUDERecallIngestor.js` | Already covered by existing `fdaMaudeIngestor.ts`. |
| `triggers/asc/CMSASCListIngestor.js` | Already covered by existing `cmsDataIngestor.ts`. |
| `triggers/accreditation/*ExpiryWatcher.js` | Phase D — single `accreditationExpiryWatcher.ts` reading from existing `accreditations` table. |
| `triggers/construction/CountyPermitIngestor.js` | Out of scope for v2; lives in the existing `facilityConstruction` table conceptually. |
| `triggers/leadership/LeadershipTurnoverDetector.js` | Out of scope for v2; the existing `signalTypeEnum` already has `leadership_change`. |
| `verticals/*Vertical.js` | Single `services/verticals/verticalOrchestrator.ts` driven by `vertical_modules` rows in Phase C. |
| `opportunity/{OpportunityScorer, OpportunityGenerator, WeeklyDigestJob}.js` | `opportunity/opportunityScorer.ts`, `opportunity/opportunityGenerator.ts`, `opportunity/weeklyDigestJob.ts` (Phase E). |

---

## Frontend reconciliation

| Handoff (`apps/web/src/…`) | This repo (`artifacts/web/src/…`) |
|---|---|
| `pages/opportunities/OpportunityInbox.jsx` | `pages/opportunities/index.tsx` (Phase E) |
| `pages/opportunities/OpportunityDetail.jsx` | `pages/opportunities/detail.tsx` (Phase E) |
| `components/opportunities/OpportunityCard.jsx`, `TriggerBadge.jsx`, `DecisionMakerTriangle.jsx`, `ConfidenceDot.jsx`, `BidDraftPanel.jsx` | Same components, `.tsx`. Routed via Wouter, not React Router. |

---

## Phased plan (5 PRs, each independently mergeable)

| Phase | Scope | Schema changes | New services | Web |
|---|---|---|---|---|
| **A** | Strategic content adoption (this PR) | None | None | None |
| **B** | Confidence + citation foundation | `intelligence_claims`, `source_weights`, `manufacturer_eol_catalog`, extend `equipment_records`, `compute_claim_confidence()` function | `claimRegistry`, `confidenceScorer`, `contradictionDetector` (cron) | None |
| **C** | Verticals + manufacturer EOL matcher | `vertical_modules`, `facility_vertical_map`, extend `equipment_line_profiles` | `verticalOrchestrator`, `manufacturerEolMatcher` | None |
| **D** | Equipment-age inference engine | `equipment_age_evidence`, `v_equipment_age_inferred` view, staging tables for state registries | `equipmentAgeInferenceOrchestrator`, state-registry adapters (staging-driven), `accreditationExpiryWatcher` | None |
| **E** | Opportunity Inbox | `opportunities` (RLS), `opportunity_actions`, `job_postings`, extend `facility_contacts` with buyer_role, `buyerRoleEnum` | `opportunityScorer`, `opportunityGenerator`, `weeklyDigestJob` | `/opportunities` inbox + detail pages |

Each phase ships as its own PR with passing `pnpm run typecheck` and
production builds, and each phase's PR description appends a stanza to
this file's history (below) describing what was kept, adapted, or
deferred.

---

## Non-negotiable rules — confirmation that v1 already enforces them

| Handoff Rule | Enforced where in this repo |
|---|---|
| Rule 1: Never auto-send messages | `outreachDrafts.status = 'sent'` means "pushed to CRM as a pending draft." Documented at the top of `services/batchRunner.ts` and `services/crmPush.ts`. |
| Rule 2: Dual-gate enrichment approval | `EnrichmentSourceApproval` table + `*_ENABLED` env var checks in `services/enrichment.ts`. |
| Rule 3: Single-source claims are never `verified` | Will be enforced in Phase B via `compute_claim_confidence()` requiring `LEAST(1.0, SUM(weighted))` plus a distinct-source check. |
| Rule 4: RLS tenant isolation | `withRLS(accountId, …)` wrapper in `lib/db/src/index.ts`. Every authenticated request runs inside it via `middlewares/rlsTransaction.ts`. |
| Rule 5: GHL `locationId` always explicit | Existing `subAccounts.crmSubId` + `subAccounts.crmCredentials` per-tenant. The `crmAdapters/ghl.ts` adapter throws if `locationId` is missing. |
| Rule 6: No LinkedIn/Indeed scraping | The existing ingestor catalog only includes Adzuna-style adapters when those are added in Phase D/E. No LinkedIn/Indeed code path exists. |
| Rule 7: No PHI ever | Existing schema is facility-level, non-clinical, public-data only. No claims, diagnoses, or treatments columns anywhere. |

---

## Change history per phase

### Phase A — Strategic content adoption · 2026-05-20

#### Added
- `docs/medintel/00_STRATEGIC_PLAN.md` (verbatim from handoff)
- `docs/medintel/01_ARCHITECTURE.md` (verbatim — read against the table in
  this file when path references diverge from the actual codebase)
- `docs/medintel/02_CODING_CONVENTIONS.md`
- `docs/medintel/03_TESTING_STRATEGY.md`
- `docs/medintel/04_DATA_SOURCES.md`
- `docs/medintel/05_GLOSSARY.md`
- `docs/medintel/verticals/{asc,imaging_center,orthopedic,rural_hospital,veterinary}.md`
- `docs/MIGRATING_FROM_HANDOFF.md` (this file)

#### Deferred
- The handoff's `tasks/PHASE_N_*.md` files are not copied; they reference
  the wrong paths/stack. The phased plan in this file is the canonical
  one; see the table above.

### Phase B — Confidence + citation foundation · 2026-05-20

#### Added (Drizzle schema in `lib/db/src/schema/confidence.ts`)
- `source_weights` (TEXT PK, NUMERIC weight, description, notes)
- `intelligence_claims` (BIGSERIAL id, entity_table TEXT, entity_id UUID,
  claim_field, claim_value, source_type, source_url, source_weight,
  observed_at, contradicted_by FK self-ref)
- `manufacturer_eol_catalog` (id, manufacturer, modality, model,
  generation, market_release_year, service/parts/software end dates,
  successor_model, source_url)
- `equipment_source_citations` (id, equipment_record_id UUID, source_type,
  observed_install_year, weight)

#### Added (extensions to existing `equipment_records` in
`lib/db/src/schema/intelligence.ts`)
- `confidence_score`, `source_count`, `first_seen_at`, `last_verified_at`,
  `contradicted`, `state_registry_id`, `fda_listing_number`,
  `manufacturer_eol_date`, `manufacturer_support_ended`
- New indexes on `(facility_id, modality)`, `install_year`,
  `manufacturer_eol_date`

#### Added (services in `artifacts/api-server/src/services/confidence/`)
- `claimRegistry.ts` — record / recordBatch / getConfidence /
  getClaimsForField with a 5-minute in-memory weight cache and a
  0.40 fallback for unknown source types.
- `confidenceScorer.ts` — `assess()` returns `{ bestValue, status,
  confidence, sourceCount, sources, competing[] }` where status is
  `verified | provisional | contradicted | unknown` per the two-source +
  0.6 weight rule from the strategic plan §5.
- `contradictionDetector.ts` — nightly sweep flagging losing claim
  values (≥0.3 weight, beaten by a winner ≥1.5x) with
  `contradicted_by`; ambiguous tuples logged at WARN for human review.

#### Added (cron)
- 02:30 America/Chicago daily — `detectContradictions` runs ahead of the
  02:45 medintel scan and the 03:00 composite score recompute.

#### Added (one-time SQL companion script)
- `lib/db/src/scripts/v2_confidence_layer.sql` — idempotent installer for
  `compute_claim_confidence()` PL/pgSQL function (180-day half-life),
  the equipment_source_citations FK, and the 38-row source_weights +
  27-row manufacturer_eol_catalog seed data.

#### Added (tests)
- `artifacts/api-server/tests/confidence-scorer.test.ts` — 9 vitest cases
  covering the verified / provisional / contradicted / unknown status
  logic and the half-life override table.

#### Verified
- `pnpm run typecheck` — clean across all 4 workspaces.
- `pnpm exec vitest run tests/confidence-scorer.test.ts` — 9/9 pass.

#### Deferred
- Wiring existing ingestors (NPPES, HRSA, FDA MAUDE, …) to write
  intelligence_claims rows during their normal runs — that's a Phase E
  follow-up where the Opportunity Inbox starts consuming
  ConfidenceScorer.assess() for every claim it surfaces.

### Phase C — Verticals + manufacturer EOL matcher · 2026-05-20

#### Added (Drizzle schema, `lib/db/src/schema/app.ts`)
- `vertical_modules` — five system verticals (imaging_center, orthopedic,
  asc, rural_hospital, veterinary) with signal-weight overrides as JSONB.
- `facility_vertical_map` — composite (facility_id, vertical_id) PK;
  unique partial index enforces "at most one is_primary per facility".
- `equipment_line_profiles.vertical_slug` — bridge field tying our
  product-facing equipment lines to the brief's customer-facing verticals.

#### Added (services)
- `services/verticals/verticalOrchestrator.ts` — seeds the 5 system
  verticals at startup (idempotent), assigns facilities by
  `facility_type` plus CAH / FQHC overrides, exposes
  `getVerticalWeightsForFacility()` for the OpportunityScorer (Phase E).
  Includes `normaliseSignalWeights()` that maps the handoff's
  natural-language keys (`manufacturer_eol`, `acr_iac_expiry`,
  `cms_procedure_volume_growth`, …) to our `signalTypeEnum` values via a
  16-row alias table.
- `services/equipmentAge/manufacturerEolMatcher.ts` — joins
  `equipment_records` to the Phase B `manufacturer_eol_catalog`, sets
  `manufacturer_eol_date` and `manufacturer_support_ended` on each
  match, emits `eol_equipment` `purchase_signals` rows (confidence 90 if
  support has ended, 70 otherwise), and records an
  `intelligence_claim` per match with the `manufacturer_eol_bulletin`
  source weight.

#### Added (startup, `artifacts/api-server/src/index.ts`)
- `seedSystemVerticals()` runs after `seedSystemEquipmentLineProfiles()`
  so the catalog is ready before the first cron tick.

#### Added (cron, `artifacts/api-server/src/cron/index.ts`)
- 02:15 daily — `classifyVerticals` runs `classifyAllUnassigned()` to
  bucket newly-ingested facilities.
- 02:20 daily — `manufacturerEol` runs the EOL matcher. New
  `eol_equipment` signals feed the 03:00 composite recompute.

#### Added (tests)
- `artifacts/api-server/tests/vertical-orchestrator.test.ts` — 10 vitest
  cases covering facility-type matching, CAH/FQHC overrides, the
  alias-table collapse (multiple `*_expiry` aliases →
  `accreditation_renewal`), and unknown facility types.

#### Verified
- `pnpm run typecheck` — clean across all 4 workspaces.
- `vitest run` — 19/19 pass (Phase B 9 + Phase C 10).

#### Deferred
- Per-vertical outreach sequences (`vertical_modules.outreach_sequence_id`
  populated). Phase E will wire bid-draft templates per vertical via the
  NEPQ hook templates documented under `docs/medintel/verticals/`.
- Per-vertical report templates (`vertical_modules.report_template`).
  Same Phase E milestone.

### Phase D — Equipment-age inference engine · _pending_

### Phase D — Equipment-age inference engine · _pending_

### Phase E — Opportunity Inbox · _pending_
