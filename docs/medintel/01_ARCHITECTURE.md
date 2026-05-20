# 01 — v1.0 Architecture Context

This is the v1.0.0 architecture you are extending. **Read this before touching any code.** Do not re-invent what already exists.

---

## Repo structure (v1.0)

```
medintel-os/
├── apps/
│   ├── api/                         # Node.js + Express backend
│   │   ├── src/
│   │   │   ├── config/              # database.js, env.js, logger.js, anthropic.js
│   │   │   ├── middleware/          # auth, tenantContext (RLS), rateLimiter, errorHandler
│   │   │   ├── routes/              # Express route mounts
│   │   │   ├── controllers/         # Thin HTTP layer — delegates to services
│   │   │   ├── services/
│   │   │   │   ├── enrichment/      # EnrichmentOrchestrator + per-source adapters
│   │   │   │   │   └── sources/     # NPIRegistrySource, CMSBillingSource, DoximitySource, etc.
│   │   │   │   ├── crm/             # GHLAdapter, HubSpotAdapter, ApideckAdapter
│   │   │   │   ├── ai/              # ClaudeClient, prompt templates
│   │   │   │   ├── ingestion/       # Raw data ingestors
│   │   │   │   ├── reports/         # Report generators with templates
│   │   │   │   ├── batch/           # BatchSyncProcessor (no-auto-send enforcer)
│   │   │   │   └── signals/         # v1.0 basic signal detectors
│   │   │   ├── models/              # Plain JS data objects (no ORM)
│   │   │   └── workers/             # Background job runners
│   │   └── tests/
│   ├── web/                         # React + Vite frontend
│   │   └── src/
│   │       ├── pages/               # Route components
│   │       ├── components/          # Shared UI
│   │       ├── hooks/
│   │       ├── store/               # Zustand stores
│   │       ├── api/                 # Axios clients
│   │       └── utils/
├── database/
│   ├── migrations/                  # 001 through 006 (v1.0); 007+ is your work
│   └── seeds/                       # Initial seed data
├── packages/shared/                 # Code shared between api and web
└── scripts/                         # Setup, migrate, seed helpers
```

---

## v1.0 database schema (the 21-table central intelligence layer)

These tables already exist. Do not recreate them. Reference them from your new migrations.

### Central intelligence (shared across all tenants — platform-owned moat)
- `facilities` — NPI, name, type, beds, ownership, state, city, lat/lng, CMS ID, CAH/DSH/SCP/FQHC designations
- `financial_documents` — type (990, HCRIS, CON, SEC, AnnualReport), fiscal year, raw text, parsed JSON
- `equipment_records` — facility ID, modality, manufacturer, model, install year, book value, accumulated depreciation, % depreciated, source doc, radiation registry confirmed flag (**v2.0 will extend this in Migration 007**)
- `purchase_signals` — facility ID, signal type, signal value, confidence, source, detected at, expires at
- `con_filings` — facility ID, state, filing date, equipment type, approved amount, status, filing URL
- `facility_contacts` — facility ID, name, title, department, email, phone, LinkedIn URL, NPI (**v2.0 will extend this in Migration 011**)
- `gpo_memberships` — facility ID, GPO name (Vizient, Premier, HealthTrust, etc.), tier
- `procedure_volumes` — facility ID, CPT code, year, count (from CMS Medicare claims)
- `technology_stack` — facility ID, system type (EHR, PACS, RIS, EMR), vendor, product, version
- `accreditations` — facility ID, body (ACR, IAC, AAAHC, AAAASF, Joint Commission, AAHA), modality, status, granted at, expires at (**v2.0 will extend this in Migration 010**)
- `quality_metrics` — facility ID, metric name, value, period, source
- `workforce_signals` — facility ID, role, posting count, source, observed at
- `research_activity` — facility ID, grant or trial ID, funder, title, amount, dates
- `construction_projects` — facility ID, project type, dollar amount, status, source URL
- `competitive_installs` — facility ID, competitor name, modality, observed at, evidence
- `regulatory_actions` — facility ID, action type, body, severity, observed at, source
- `community_designations` — facility ID, designation type (DSH, SCP, FQHC, CAH, 340B), value, period
- Plus 4 more (CHNA reports, financial benchmarks, market position, special funding programs)

### Tenant layer (RLS-enforced per `account_id`)
- `accounts` — tenant accounts (Chicago Medex, etc.)
- `users` — per-account users
- `account_facility_subscriptions` — which facilities a tenant has subscribed to
- `outreach_drafts` — pending CRM-bound drafts (status: pending → sent-to-CRM-as-draft → archived)
- `crm_sync_log` — every CRM push attempt
- `enrichment_source_approvals` — DB half of the dual-gate (paired with `*_ENABLED` env vars)

---

## Critical v1.0 systems you are extending

### EnrichmentOrchestrator
Location: `apps/api/src/services/enrichment/EnrichmentOrchestrator.js`

Key method: `isSourceApproved(sourceName, accountId)` — checks both the DB approval row AND the env var. Both must be true. Approval cache invalidates on UI approve/revoke and takes effect on the next queue run (within 30 min).

**v2.0 work:** add new sources under `apps/api/src/services/enrichment/sources/` for any paid source that needs the dual gate. Free sources go directly under `apps/api/src/services/triggers/` or `apps/api/src/services/equipment_age/` without the approval gate.

### BatchSyncProcessor
Location: `apps/api/src/services/batch/BatchSyncProcessor.js`

The doc comment at the top says: `outreach_drafts.status = 'sent'` explicitly means "pushed to CRM as pending draft" — not actually sent to a recipient. Rep approval is required for every send. Do not change this semantics. v2.0's Opportunity Inbox feeds into this same flow.

### Tenant context middleware
Location: `apps/api/src/middleware/tenantContext.js`

Sets `SET LOCAL app.account_id = '<uuid>'` at the start of every request transaction. Every RLS-enabled table relies on this. Never run a tenant-scoped query outside a request-bound transaction.

### Enrichment source adapters
Pattern: every source is a class with a single `enrich(facility, options)` method. Sources are registered in the `SOURCE_REGISTRY` map at the top of `EnrichmentOrchestrator.js`.

### The 10-tier intelligence model (v1.0 conceptual layers)
Already implemented:
1. GPO & Procurement Architecture (`gpo_memberships`)
2. Clinical Volume & Procedure Data (`procedure_volumes`)
3. Technology & IT Stack (`technology_stack`)
4. Quality, Accreditation & Certification (`accreditations`, `quality_metrics`)
5. Workforce & Hiring Signals (`workforce_signals` — basic)
6. Research, Grants & Clinical Trials (`research_activity`)
7. Construction, Expansion & Capital Projects (`construction_projects`)
8. Competitive & Installed Base Intelligence (`competitive_installs`)
9. Regulatory, Compliance & Citations (`regulatory_actions`)
10. Community, Market Position & Special Designations (`community_designations`)

**v2.0 adds layers 11–14:** the capital trigger engine, equipment-age inference, behavioral signal engine, and confidence-and-validation layer. These are not parallel to the existing 10 tiers — they sit on top and consume from them.

---

## Env vars to know about

The v1.0 `.env.example` includes these. v2.0 will add more for the new sources.

```bash
DATABASE_URL=postgresql://...
JWT_SECRET=...
ANTHROPIC_API_KEY=...

# Free sources (always on, no env gate)
NPI_REGISTRY_BASE_URL=https://npiregistry.cms.hhs.gov/api
PROPUBLICA_990_BASE_URL=https://projects.propublica.org/nonprofits/api/v2

# Paid sources — dual gate (env + DB approval)
DOXIMITY_ENABLED=false
DOXIMITY_API_KEY=
OUTSCRAPER_ENABLED=false
OUTSCRAPER_API_KEY=
SEARCHATLAS_ENABLED=false
SEARCHATLAS_API_KEY=

# v2.0 additions (will be added in Phase 2):
ADZUNA_ENABLED=false
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
USAJOBS_ENABLED=false
USAJOBS_API_KEY=
EMMA_ENABLED=true
FDA_OPENFDA_ENABLED=true
```

---

## How v2.0 plugs in

The v2.0 stack adds new tables and new services. It does not replace anything in v1.0. The integration points:

1. **Migrations 007–013** extend existing tables and add new ones. The existing `equipment_records` and `facility_contacts` get new columns (additive only).
2. **New services** under `apps/api/src/services/{triggers,equipment_age,behavioral,confidence,verticals,opportunity}/` run on cron and write into the new tables.
3. **Opportunity Inbox** is a new React page that reads from `opportunities` and pushes to `outreach_drafts` (existing v1.0 table) when a rep clicks "Pursue".
4. **The dual-gate enrichment system** is reused for any v2.0 paid source. The cron jobs check `isSourceApproved()` before each run.
5. **RLS is preserved.** Every new tenant-scoped table (`opportunities`, future per-tenant views) has the same `account_id` column + RLS policy pattern as v1.0.

---

*Updated for v2.0 handoff · May 19, 2026*
