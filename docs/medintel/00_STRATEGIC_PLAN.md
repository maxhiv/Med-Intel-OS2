# MedIntel OS v2.0 — Lead Intelligence Engine
**HOS Venture Council Strategic Plan · Capital Medical Equipment Lead Generation**

*Hansen Holdings · SaaS Lab · Fairhope, Alabama*
*First client: Chicago Medical Exchange · Timothy D. Carter*
*Target verticals: Imaging Centers, Orthopedics, Ambulatory Surgery Centers, Rural Hospitals, Veterinary*

---

## 1. Strategic Position

### Where MedIntel OS v1.0.0 stands
The v1.0.0 scaffold is solid. The 21-table central intelligence schema, RLS-enforced multi-tenancy, dual-gate enrichment approval system (`enrichment_source_approvals` DB row + `*_ENABLED` env var), and the no-auto-send batch sync rule are production-grade. The free-source enrichment stack (NPI, CMS billing, Doximity, ProPublica 990, NIH Reporter, ClinicalTrials.gov, professional directories, website scrape) gives every account a baseline profile within minutes of ingestion.

### The competitive gap
| Vendor | Price | Strength | Weakness for our ICP |
|---|---|---|---|
| Definitive Healthcare HospitalView | $30–50K/seat/yr | Predicted Buyer Score, 9,300+ hospital profiles | Built for OEMs, not brokers / dealers; black-box scoring; no broker-tier pricing |
| IQVIA | $40K+/seat | Best provider/Rx data | Pharma-first; light on capital equipment signals |
| Komodo Health | $30K+ | Claims-level patient journeys | Not lead-gen; HEOR/RWE oriented |
| Ampliz, Provyx, CarePrecise | $5K–$15K/yr | Cheap contact data | No signal layer; pure firmographics |
| ZoomInfo / Apollo | $2K–$10K/yr | Broad B2B | No healthcare-specific signals at all |

**MedIntel's wedge:** the capital equipment broker / dealer / used-equipment channel that Definitive has priced out and ZoomInfo can't serve. These reps run 5–10% margins on $80K–$1.2M transactions, can't justify $30–50K/seat, and need *trigger signals* not just firmographics.

### The strategic shift in v2.0
v1.0.0 answers *"who is this facility?"* — v2.0 answers *"when is this facility about to buy, and from whom?"* This is the move from a directory to a trigger-first intelligence engine. The competitive moat is not raw data quantity; it's **transparent confidence scoring with a citation trail per signal**.

---

## 2. The 9-Layer Lead Intelligence Stack

| Layer | Name | Status | Owner |
|---|---|---|---|
| L1 | Identity foundation | v1.0 ✓ | Existing |
| L2 | Equipment inventory | v1.0 partial — expand | Migration 007 |
| L3 | Capital trigger engine | NEW | Migration 008 |
| L4 | Equipment-age inference engine | NEW | Migration 009 |
| L5 | Behavioral signal engine | NEW | Migration 010 |
| L6 | Decision-maker graph | v1.0 partial — expand | Migration 011 |
| L7 | Vertical specialization modules | NEW | Migration 012 |
| L8 | Confidence and validation layer | NEW | Migration 013 |
| L9 | Outreach production | v1.0 ✓ — extend with vertical playbooks | Existing + extension |

---

## 3. Data Source Catalog (the moat)

This is the full source taxonomy. Tier A = high signal, primary triggers. Tier B = enrichment / context. Tier C = vertical-specific.

### Tier A — Primary capital trigger signals (highest predictive value)

1. **State Certificate of Need (CON) filings** — 35 states + DC, all public. Trigger thresholds vary ($350K–$3.5M for major medical equipment). FL, IL, NY, NC, MA, NJ, OH, GA, MI, MD have the most active programs. Build state-specific scrapers; standardize into a single `con_filings` schema.

2. **CMS HCRIS Medicare Cost Reports** (Worksheet A-7) — Annual filings from all Medicare-certified hospitals. Shows depreciation by asset class (movable equipment vs buildings), accumulated depreciation, and current-year capital additions. Public via the CMS Provider Cost Report Public Use File. Equipment >70% depreciated = imminent replacement signal.

3. **EMMA Municipal Bond filings (MSRB)** — Public hospitals and non-profit health systems file Official Statements with the Municipal Securities Rulemaking Board. Capital plans, equipment acquisition lists, and bond use-of-proceeds are itemized. Free at emma.msrb.org.

4. **IRS Form 990 Schedule D + Schedule I** — All tax-exempt hospitals. Schedule D shows asset detail; Schedule I shows capital grants to affiliates. ProPublica Nonprofit Explorer + IRS direct download. Already in v1.0 partially — extend to Schedule D parsing.

5. **State radiation control program registries** — Every state registers diagnostic X-ray, fluoroscopy, CT, and mammography equipment. Texas DSHS, Florida DOH, California DPH, Illinois IEMA all publish lookups. Install year + serial number + facility = ground truth on equipment age.

6. **FDA MAUDE recalls and Class I/II safety alerts** — When a manufacturer issues a Class I recall on a CT scanner model, every facility with that model becomes a replacement candidate. FDA OpenFDA API is free and reasonably structured.

7. **CMS ASC Covered Procedures List expansion** — CMS publishes the annual ASC-payable list. When a CPT moves outpatient → ASC (cardiac ablation, spine, total joint), every ASC in that subspecialty becomes a capital prospect for the equipment required.

8. **ACR / IAC / AAAHC / AAAASF accreditation expiry** — Imaging facilities renew ACR accreditation every 3 years. ASCs renew AAAHC every 3 years. AAAHC and ACR both publish accredited facility lookups. Expiry-within-12-months is a high-signal "upgrade window".

### Tier B — Behavioral / context signals

9. **Modality-tagged job postings** — Indeed / Adzuna / Jooble / USAJobs (public-payer-funded jobs are 100% legal to scrape). Velocity of hiring for "MRI Technologist", "CT Tech", "Mammographer", "C-arm Tech", "Surgical First Assistant — Robotics" maps directly to equipment volume scaling.

10. **Leadership turnover** — New CMO, CFO, VP of Imaging, Director of Surgical Services = new capital priorities. LinkedIn changes, hospital press releases, board minutes. Net new in role within last 6 months = high re-evaluation probability.

11. **CHNA reports (Community Health Needs Assessment)** — Every tax-exempt hospital must file every 3 years (IRS §501(r)). Reports identify equipment / capacity gaps that drive capital plans. Hospital websites + IRS 990 Schedule H.

12. **Construction permits** — County / city building department permits over $500K for healthcare occupancy = new wing, new ASC, new imaging center. Most counties publish via online portals; aggregators include BuildZoom and SmartProcure.

13. **Press releases and news monitoring** — "Hospital X breaks ground on $40M expansion" is a 12-month leading indicator for equipment RFPs. Use Google News API or NewsAPI; filter by NPI-mapped facility names.

14. **HRSA Rural Hospital Stabilization + USDA Community Facilities loans** — Both publish loan recipients. Rural hospitals receiving capital = rural hospitals buying.

15. **340B program enrollment** — HRSA OPAIS database. 340B participation = drug-margin-funded capital. Rural and safety-net signal.

16. **HRSA Small Rural Hospital Improvement Program (SHIP) grants** — Up to $15K per critical access hospital annually, often used for equipment match. Public grant award lists.

### Tier C — Vertical-specific signals

17. **Imaging:** ACR registry participation (NRDR, DIR, LCSR) — registry membership indicates a forward-leaning practice. ACR ranking of MRI / CT / mammo / PET volume.

18. **Orthopedics:** AAOS membership directory, ABOS board certification lookup, CMS Physician Compare procedure volumes (CPT 27447 = total knee, CPT 27130 = total hip). Volume scaling + age of surgical robot install = replacement window.

19. **ASC:** Medicare ASC list (each ASC has a CMS Certification Number — CCN), ASCA membership, AAAHC / AAAASF accreditation lookup, state ASC license boards. AAAHC's standards updates often force equipment refresh.

20. **Rural hospital:** CAH (Critical Access Hospital) designation list — CMS publishes the 1,360 CAH facilities. DSH adjustment factor + 340B + SCP (Sole Community Provider) status. USDA Rural Development equipment grants.

21. **Veterinary:** USDA APHIS licensed veterinary facility lookup, AAHA (American Animal Hospital Association) accreditation lookup (≈15% of US vet practices, all upgrade-prone), AVMA accredited college lookup (teaching hospital prospects). Consolidator hierarchies: Mars Veterinary Health, NVA, VCA / Banfield, BluePearl, Pathway, PetVet Care Centers.

---

## 4. SQL Migrations (007–013)

### Migration 007 — `equipment_inventory_expanded.sql`

```sql
-- Extends the v1.0 equipment_records table with confidence and source provenance
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(3,2) DEFAULT 0.0 CHECK (confidence_score BETWEEN 0 AND 1);
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS source_count INT DEFAULT 1;
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS contradicted BOOLEAN DEFAULT FALSE;
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS serial_number TEXT;
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS state_registry_id TEXT;
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS fda_listing_number TEXT;
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS manufacturer_eol_date DATE;
ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS manufacturer_support_ended BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS equipment_source_citations (
  id BIGSERIAL PRIMARY KEY,
  equipment_record_id BIGINT NOT NULL REFERENCES equipment_records(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL, -- 'state_radiation_registry', 'hcris_a7', '990_schedule_d', 'fda_maude', 'manufacturer_bulletin', 'manual'
  source_id TEXT, -- URL or document ID
  source_excerpt TEXT,
  observed_install_year INT,
  observed_at TIMESTAMPTZ DEFAULT NOW(),
  weight NUMERIC(3,2) DEFAULT 0.5
);

CREATE INDEX idx_equipment_records_facility_modality ON equipment_records(facility_id, modality);
CREATE INDEX idx_equipment_records_age ON equipment_records(install_year) WHERE install_year IS NOT NULL;
CREATE INDEX idx_equipment_citations_record ON equipment_source_citations(equipment_record_id);
```

### Migration 008 — `capital_trigger_engine.sql`

```sql
-- Capital triggers: discrete events that signal an imminent purchase decision
CREATE TYPE trigger_category AS ENUM (
  'con_filing', 'bond_issuance', '990_capex', 'hcris_depreciation',
  'construction_permit', 'cms_asc_list_change', 'fda_recall',
  'manufacturer_eol', 'accreditation_expiry', 'leadership_change',
  'press_release', 'usda_loan', 'hrsa_grant', 'chna_gap'
);

CREATE TABLE IF NOT EXISTS capital_triggers (
  id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  category trigger_category NOT NULL,
  modality TEXT, -- 'MRI', 'CT', 'mammo', 'fluoro', 'ultrasound', 'C-arm', 'surgical_robot', 'linac', 'PET', 'DXA', etc.
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ, -- triggers decay; CON typically valid 3 years
  signal_strength NUMERIC(3,2) NOT NULL CHECK (signal_strength BETWEEN 0 AND 1),
  confidence_score NUMERIC(3,2) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
  dollar_amount NUMERIC(14,2),
  source_url TEXT,
  source_excerpt TEXT,
  raw_payload JSONB,
  metadata JSONB DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  superseded_by BIGINT REFERENCES capital_triggers(id)
);

CREATE INDEX idx_capital_triggers_facility_active ON capital_triggers(facility_id, observed_at DESC)
  WHERE expires_at IS NULL OR expires_at > NOW();
CREATE INDEX idx_capital_triggers_modality ON capital_triggers(modality, observed_at DESC);
CREATE INDEX idx_capital_triggers_category ON capital_triggers(category, observed_at DESC);

-- Composite buying-readiness view
CREATE OR REPLACE VIEW v_facility_buying_readiness AS
SELECT
  f.id AS facility_id,
  f.name,
  f.type,
  f.state,
  COUNT(t.id) FILTER (WHERE t.expires_at IS NULL OR t.expires_at > NOW()) AS active_triggers,
  MAX(t.observed_at) AS last_trigger_at,
  -- Weighted composite score
  COALESCE(SUM(t.signal_strength * t.confidence_score), 0) AS readiness_score,
  -- Top trigger
  (ARRAY_AGG(t.category ORDER BY t.signal_strength * t.confidence_score DESC NULLS LAST))[1] AS top_category,
  (ARRAY_AGG(t.modality ORDER BY t.signal_strength * t.confidence_score DESC NULLS LAST))[1] AS top_modality
FROM facilities f
LEFT JOIN capital_triggers t ON t.facility_id = f.id
GROUP BY f.id, f.name, f.type, f.state;
```

### Migration 009 — `equipment_age_inference.sql`

```sql
-- Equipment-age evidence: multi-source triangulation
CREATE TABLE IF NOT EXISTS equipment_age_evidence (
  id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  modality TEXT NOT NULL,
  manufacturer TEXT,
  model TEXT,
  evidence_type TEXT NOT NULL, -- 'state_registry', 'hcris_a7_age_distribution', 'fda_510k_clearance_date', 'manufacturer_eol_announcement', '990_acquisition_year', 'permit_application_date', 'photo_metadata', 'rep_field_report'
  evidence_value JSONB NOT NULL, -- { "install_year": 2017, "serial": "ABC123", "registry_url": "...", "extracted_at": "..." }
  inferred_install_year INT,
  evidence_weight NUMERIC(3,2) NOT NULL CHECK (evidence_weight BETWEEN 0 AND 1),
  source_url TEXT,
  observed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_equipment_age_facility ON equipment_age_evidence(facility_id, modality);

-- Manufacturer end-of-life knowledge base
CREATE TABLE IF NOT EXISTS manufacturer_eol_catalog (
  id BIGSERIAL PRIMARY KEY,
  manufacturer TEXT NOT NULL,
  modality TEXT NOT NULL,
  model TEXT NOT NULL,
  generation TEXT,
  market_release_year INT,
  service_end_date DATE,
  parts_end_date DATE,
  software_eol_date DATE,
  successor_model TEXT,
  source_url TEXT,
  source_excerpt TEXT,
  UNIQUE (manufacturer, modality, model)
);

-- Inferred age view — combines all evidence into a best estimate per (facility, modality)
CREATE OR REPLACE VIEW v_equipment_age_inferred AS
WITH ev AS (
  SELECT
    facility_id,
    modality,
    manufacturer,
    SUM(inferred_install_year * evidence_weight) / NULLIF(SUM(evidence_weight), 0) AS weighted_install_year,
    SUM(evidence_weight) AS total_weight,
    COUNT(*) AS evidence_count,
    ARRAY_AGG(DISTINCT evidence_type) AS evidence_types,
    MAX(observed_at) AS last_evidence_at
  FROM equipment_age_evidence
  WHERE inferred_install_year IS NOT NULL
  GROUP BY facility_id, modality, manufacturer
)
SELECT
  ev.*,
  ROUND(weighted_install_year)::INT AS estimated_install_year,
  EXTRACT(YEAR FROM CURRENT_DATE) - ROUND(weighted_install_year) AS estimated_age_years,
  -- Confidence rises with source count and total weight, decays with age of evidence
  LEAST(1.0, (total_weight * 0.6 + LEAST(evidence_count, 4) * 0.1)) AS age_confidence
FROM ev;
```

### Migration 010 — `behavioral_signals.sql`

```sql
CREATE TABLE IF NOT EXISTS behavioral_signals (
  id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  modality TEXT,
  signal_value JSONB NOT NULL,
  source TEXT,
  source_url TEXT,
  observed_at TIMESTAMPTZ DEFAULT NOW(),
  decay_half_life_days INT DEFAULT 90,
  signal_weight NUMERIC(3,2) DEFAULT 0.5
);

CREATE INDEX idx_behavioral_facility ON behavioral_signals(facility_id, observed_at DESC);
CREATE INDEX idx_behavioral_type ON behavioral_signals(signal_type);

-- Job postings: modality-tagged hiring velocity
CREATE TABLE IF NOT EXISTS job_postings (
  id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT REFERENCES facilities(id),
  source TEXT NOT NULL, -- 'indeed', 'adzuna', 'jooble', 'usajobs', 'company_site'
  title TEXT NOT NULL,
  modality_tags TEXT[],
  posted_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  url TEXT,
  raw JSONB
);

CREATE INDEX idx_jobs_facility_modality ON job_postings(facility_id, modality_tags);

-- Accreditation expiry watchlist
CREATE TABLE IF NOT EXISTS accreditation_records (
  id BIGSERIAL PRIMARY KEY,
  facility_id BIGINT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  body TEXT NOT NULL, -- 'ACR', 'IAC', 'AAAHC', 'AAAASF', 'AAHA', 'Joint_Commission'
  modality TEXT,
  status TEXT, -- 'active', 'expired', 'suspended'
  granted_at DATE,
  expires_at DATE,
  source_url TEXT,
  UNIQUE (facility_id, body, modality)
);

CREATE INDEX idx_accreditation_expiry ON accreditation_records(expires_at) WHERE status = 'active';
```

### Migration 011 — `decision_maker_graph_expanded.sql`

```sql
-- Roles within an opportunity: clinical champion, economic buyer, gatekeeper
CREATE TYPE buyer_role AS ENUM (
  'clinical_champion', 'economic_buyer', 'procurement_gatekeeper',
  'technical_evaluator', 'end_user', 'executive_sponsor', 'finance_approver', 'compliance_reviewer'
);

ALTER TABLE facility_contacts ADD COLUMN IF NOT EXISTS buyer_role buyer_role;
ALTER TABLE facility_contacts ADD COLUMN IF NOT EXISTS modality_authority TEXT[]; -- which modalities they decide on
ALTER TABLE facility_contacts ADD COLUMN IF NOT EXISTS years_in_role INT;
ALTER TABLE facility_contacts ADD COLUMN IF NOT EXISTS started_role_at DATE;
ALTER TABLE facility_contacts ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'unverified'; -- 'verified', 'unverified', 'stale', 'bounced'
ALTER TABLE facility_contacts ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS contact_verification_log (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES facility_contacts(id) ON DELETE CASCADE,
  method TEXT NOT NULL, -- 'smtp_verify', 'phone_carrier_lookup', 'linkedin_active', 'npi_match', 'state_license_lookup'
  result TEXT NOT NULL, -- 'verified', 'unverified', 'risky', 'invalid'
  details JSONB,
  performed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Opportunity = facility + modality + active triggers
CREATE TABLE IF NOT EXISTS opportunities (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL, -- tenant scoping
  facility_id BIGINT NOT NULL REFERENCES facilities(id),
  modality TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'detected', -- 'detected', 'rep_reviewed', 'qualified', 'bid_submitted', 'won', 'lost', 'dormant'
  readiness_score NUMERIC(4,3),
  estimated_dollar_range_low NUMERIC(14,2),
  estimated_dollar_range_high NUMERIC(14,2),
  primary_trigger_id BIGINT REFERENCES capital_triggers(id),
  champion_contact_id BIGINT REFERENCES facility_contacts(id),
  economic_buyer_contact_id BIGINT REFERENCES facility_contacts(id),
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  rep_reviewed_at TIMESTAMPTZ,
  rep_assigned_to UUID,
  notes TEXT
);

CREATE INDEX idx_opportunities_account_status ON opportunities(account_id, status, readiness_score DESC);
CREATE INDEX idx_opportunities_facility ON opportunities(facility_id, modality);

-- RLS enforcement (per v1.0 pattern)
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunities_tenant_isolation ON opportunities
  USING (account_id = current_setting('app.account_id', true)::uuid);
```

### Migration 012 — `vertical_modules.sql`

```sql
-- Per-vertical scoring weights, playbooks, and signal subsets
CREATE TABLE IF NOT EXISTS vertical_modules (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE, -- 'imaging_center', 'orthopedic', 'asc', 'rural_hospital', 'veterinary'
  display_name TEXT NOT NULL,
  description TEXT,
  primary_modalities TEXT[],
  facility_type_filter TEXT[],
  signal_weights JSONB NOT NULL, -- { "con_filing": 0.95, "accreditation_expiry": 0.85, ... }
  outreach_sequence_id BIGINT,
  report_template TEXT,
  enabled BOOLEAN DEFAULT TRUE
);

-- Seed the 5 verticals
INSERT INTO vertical_modules (slug, display_name, primary_modalities, facility_type_filter, signal_weights) VALUES
('imaging_center', 'Imaging Centers',
  ARRAY['MRI','CT','mammo','PET','ultrasound','DXA','fluoro'],
  ARRAY['imaging_center','outpatient_imaging','radiology_office'],
  '{"con_filing":0.95,"acr_iac_expiry":0.90,"manufacturer_eol":0.88,"fda_recall":0.85,"hcris_depreciation":0.75,"job_posting":0.65,"construction_permit":0.60,"press_release":0.55}'::jsonb
),
('orthopedic', 'Orthopedic Surgery',
  ARRAY['surgical_robot','C-arm','fluoroscopy','navigation_system'],
  ARRAY['orthopedic_office','specialty_hospital','asc'],
  '{"cms_procedure_volume_growth":0.95,"surgical_robot_age":0.90,"job_posting_robotic":0.85,"con_filing":0.80,"asc_list_expansion":0.75}'::jsonb
),
('asc', 'Ambulatory Surgery Centers',
  ARRAY['surgical_robot','endoscopy','C-arm','anesthesia','laser','ultrasound'],
  ARRAY['asc'],
  '{"cms_asc_list_expansion":0.95,"aaahc_aaaasf_expiry":0.90,"con_filing":0.85,"hcris_depreciation":0.70,"job_posting":0.65}'::jsonb
),
('rural_hospital', 'Rural Hospitals (incl. Critical Access)',
  ARRAY['CT','ultrasound','C-arm','fluoroscopy','mammo','endoscopy','telehealth'],
  ARRAY['cah','rural_pps','sole_community_provider'],
  '{"usda_loan_award":0.95,"hrsa_grant":0.90,"con_filing":0.80,"chna_gap":0.85,"340b_enrollment_change":0.70,"hcris_depreciation":0.75,"manufacturer_eol":0.80}'::jsonb
),
('veterinary', 'Veterinary Hospitals',
  ARRAY['CT','MRI','ultrasound','dental_radiography','C-arm','anesthesia','endoscopy'],
  ARRAY['vet_general','vet_specialty','vet_emergency','vet_teaching'],
  '{"aaha_accreditation_expiry":0.85,"consolidator_acquisition":0.90,"new_facility_construction":0.85,"job_posting":0.70,"usda_aphis_change":0.65}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- Per-facility vertical assignment (one facility can map to multiple verticals)
CREATE TABLE IF NOT EXISTS facility_vertical_map (
  facility_id BIGINT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  vertical_id BIGINT NOT NULL REFERENCES vertical_modules(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (facility_id, vertical_id)
);
```

### Migration 013 — `confidence_and_validation.sql`

```sql
-- Generic confidence-scoring log for any intelligence claim
CREATE TABLE IF NOT EXISTS intelligence_claims (
  id BIGSERIAL PRIMARY KEY,
  entity_table TEXT NOT NULL, -- which table is the subject ('facilities', 'facility_contacts', 'equipment_records', ...)
  entity_id BIGINT NOT NULL,
  claim_field TEXT NOT NULL, -- which column ('email', 'install_year', 'beds', ...)
  claim_value TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  source_weight NUMERIC(3,2) NOT NULL,
  observed_at TIMESTAMPTZ DEFAULT NOW(),
  contradicted_by BIGINT REFERENCES intelligence_claims(id)
);

CREATE INDEX idx_claims_entity ON intelligence_claims(entity_table, entity_id, claim_field);

-- Confidence is computed: sum(source_weight) bounded to 1, decayed by time
CREATE OR REPLACE FUNCTION compute_claim_confidence(
  p_entity_table TEXT,
  p_entity_id BIGINT,
  p_claim_field TEXT,
  p_claim_value TEXT
) RETURNS NUMERIC AS $$
DECLARE
  v_confidence NUMERIC;
BEGIN
  SELECT LEAST(1.0,
    SUM(
      source_weight *
      -- decay: half-life 180 days
      EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - observed_at)) / (180 * 86400))
    )
  ) INTO v_confidence
  FROM intelligence_claims
  WHERE entity_table = p_entity_table
    AND entity_id = p_entity_id
    AND claim_field = p_claim_field
    AND claim_value = p_claim_value
    AND contradicted_by IS NULL;
  RETURN COALESCE(v_confidence, 0);
END;
$$ LANGUAGE plpgsql STABLE;
```

---

## 5. Confidence Scoring Algorithm

A claim is `verified` only when:

1. **N-source agreement**: At least 2 independent sources agree on the value. Single-source claims are `provisional`.
2. **Source-weight floor**: Total weighted score ≥ 0.6 after decay.
3. **No active contradiction**: No higher-weight source disagrees within the same decay window.
4. **Decay half-life**: 180 days for facility firmographics, 90 days for contacts, 365 days for equipment install year.

### Source weights (default starting values)

| Source | Weight | Notes |
|---|---|---|
| State radiation registry | 0.95 | Government, ground truth for X-ray / CT / mammo install year |
| FDA MAUDE / OpenFDA | 0.90 | Federal, authoritative for recalls |
| CMS HCRIS Worksheet A-7 | 0.85 | Federal, official cost report; reflects asset class not specific units |
| IRS Form 990 Schedule D | 0.80 | Federal; lags by 12–18 months |
| EMMA bond filing | 0.85 | Investor-grade disclosure |
| State CON filing | 0.90 | Public, attorney-reviewed |
| ACR / AAAHC / AAAASF lookup | 0.85 | Body-verified accreditation |
| Manufacturer bulletin / EOL announcement | 0.80 | OEM, may be marketing |
| Hospital press release | 0.55 | Self-reported, often aspirational |
| Job posting (single) | 0.30 | Weak alone; strong with velocity |
| Job posting velocity (5+ in 60 days) | 0.65 | Strong scaling indicator |
| LinkedIn profile (single contact) | 0.50 | Names and titles change |
| Outscraper enrichment | 0.55 | Aggregated; verify with primary |
| Rep field report | 0.75 | High weight if rep saw it firsthand; logged with date |
| Definitive Healthcare (if licensed) | 0.85 | Authoritative facility data; pay-gated |
| Random web scrape | 0.40 | Floor for unverified web content |

---

## 6. Vertical Playbooks

Each playbook lists the **6–10 highest-signal triggers**, **target contact roles**, and **outreach hooks**.

### 6.1 Imaging Centers

**ICP**: 11,000+ US freestanding imaging centers + 8,000+ hospital outpatient imaging departments.

**Top triggers (weighted)**:
1. ACR accreditation expiring in 4–12 months (0.90)
2. CT or MRI install year ≥ 8 years from state registry (0.95 if state has registry)
3. FDA Class I/II recall on installed modality (0.85)
4. Manufacturer EOL announcement matching installed model (0.85)
5. CON filing for imaging equipment in past 90 days (0.95)
6. Mammographer or MRI tech job posting velocity ≥ 3 in 60 days (0.65)
7. CHNA report identifying imaging access gap (0.55)

**Target roles**: Medical Director (clinical champion), Director of Imaging / Lead Tech (technical evaluator), CFO or VP Imaging Ops (economic buyer), Imaging Manager (gatekeeper).

**Outreach hook templates**:
- *EOL trigger*: "Saw the [Manufacturer] notice that the [Model] you're running goes out of service support in [date]. We just placed two refurb [successor model]s with similar centers in Q2 — wanted to share the build sheet."
- *ACR expiry*: "Your ACR re-accreditation cycle is up in [month]. About 40% of centers we work with use that window to upgrade the modality being audited. Happy to share what [comparable center] just did."

### 6.2 Orthopedic Surgery

**ICP**: 6,500+ orthopedic group practices, 2,200+ specialty hospitals doing orthopedic case volume, ASC ortho lines.

**Top triggers**:
1. CPT 27447 (total knee) or CPT 27130 (total hip) annual volume growth ≥ 15% YoY (0.85)
2. Surgical robot install year ≥ 5 years (Mako, ROSA, VELYS, Mazor) (0.90)
3. CMS ASC list adding a procedure they perform inpatient today (0.95)
4. AAOS-recruiter job posting velocity for "Robotic-trained" surgeons (0.70)
5. CON filing for surgical robot or C-arm (0.95)
6. ABOS board-certification additions = practice growing (0.50)

**Target roles**: Lead Surgeon (clinical champion), Practice Administrator or CEO (economic buyer), OR Director (gatekeeper).

### 6.3 Ambulatory Surgery Centers (ASC)

**ICP**: 6,000+ Medicare-certified ASCs.

**Top triggers**:
1. CMS adds a CPT to ASC payable list that the ASC's specialty performs (0.95)
2. AAAHC or AAAASF accreditation expiring within 6 months (0.85)
3. CON filing for ASC expansion or new equipment (0.90)
4. New CMS CCN (newly certified ASC) (0.85)
5. Surgical case volume growth from CMS POS-24 claims (0.70)
6. Job posting velocity for surgical first assists, anesthesia (0.65)

**Target roles**: ASC Administrator / CEO (economic buyer), Medical Director (clinical), Materials Manager (gatekeeper).

### 6.4 Rural Hospitals

**ICP**: 1,360 Critical Access Hospitals + 1,000+ small rural PPS hospitals.

**Top triggers**:
1. USDA Rural Development equipment loan award (0.95)
2. HRSA Small Rural Hospital Improvement Program grant award (0.85)
3. State CON filing (where applicable; many CON states exempt rural) (0.80)
4. 340B drug-margin growth = capital capacity (0.70)
5. CHNA report identifying CT / MRI access gap (0.75)
6. HCRIS A-7: movable equipment >70% depreciated (0.80)
7. Manufacturer EOL on CR / DR system (0.85)

**Target roles**: CEO (almost always the economic buyer in rural), CFO, Radiology Director, Materials Manager.

**Unique angle**: Rural hospitals need refurb equipment with strong service contracts and financing. Bid templates need to emphasize uptime guarantees and on-site service response time.

### 6.5 Veterinary

**ICP**: 32,000+ US vet practices; the AAHA-accredited ≈ 4,800 are the strongest upgrade-prone segment. Major consolidators: Mars (Banfield, VCA, BluePearl, AntechDiagnostics, ≈2,500 locations), National Veterinary Associates (NVA, ≈1,500), Pathway Vet Alliance, PetVet Care Centers, MedVet.

**Top triggers**:
1. AAHA accreditation expiring within 6 months (0.85)
2. Consolidator acquired the practice within last 12 months (capital refresh follows) (0.90)
3. New facility construction (county permit) (0.85)
4. Vet tech job posting velocity tagged "ultrasound", "CT", "dental rad" (0.70)
5. USDA APHIS license type change (general → specialty / referral) (0.75)
6. State vet board complaint history (forces re-equipment) (0.50)

**Target roles**: Practice Owner (independent) or Regional Medical Director (consolidator), Hospital Manager.

**Unique angle**: Vet equipment market is dominated by IDEXX, Sound Veterinary, IM3, MinXray, Universal Imaging. The broker channel is huge for refurb. Mars / NVA centralize purchasing — selling to the consolidator is different from selling to the location.

---

## 7. The Opportunity Inbox (the killer feature)

Every Monday morning, each rep sees 5–15 ready-to-bid opportunities in their inbox, ranked by:

```
opportunity_score = (
    facility_buying_readiness * 0.40 +
    trigger_recency_score * 0.20 +
    contact_confidence_score * 0.15 +
    vertical_fit_score * 0.15 +
    territory_proximity_score * 0.10
)
```

Each opportunity card shows:
- Facility name, type, city, state, beds / case volume
- Top 3 active triggers with confidence dots and source links
- Decision-maker triangle: clinical champion + economic buyer + gatekeeper, each with verification status
- Estimated dollar range based on modality + facility size
- One-click "Generate bid email" and "Generate proposal draft"
- Rep actions: 👍 Pursue · 👎 Skip · ✋ Snooze · 💬 Note · 🔗 Push to GHL

When the rep clicks **Pursue**, the opportunity flows into the GHL pipeline as a pending draft (not auto-sent, per the v1.0 BatchSyncProcessor rule).

---

## 8. CLI Scaffold Commands

```bash
# === Bootstrap v2.0 inside the existing medintel-os repo ===
cd ~/medintel-os
git checkout -b feature/v2.0-lead-intelligence

# Create new migrations
touch database/migrations/007_equipment_inventory_expanded.sql
touch database/migrations/008_capital_trigger_engine.sql
touch database/migrations/009_equipment_age_inference.sql
touch database/migrations/010_behavioral_signals.sql
touch database/migrations/011_decision_maker_graph_expanded.sql
touch database/migrations/012_vertical_modules.sql
touch database/migrations/013_confidence_and_validation.sql

# Trigger ingestion services (one per Tier-A source)
mkdir -p apps/api/src/services/triggers/{con,bond,hcris,form990,fda,asc,accreditation,construction,leadership}
touch apps/api/src/services/triggers/con/{FloridaCONScraper.js,IllinoisCONScraper.js,NewYorkCONScraper.js,NorthCarolinaCONScraper.js,MassachusettsCONScraper.js,TexasCONScraper.js,AlabamaCONScraper.js,SharedCONNormalizer.js}
touch apps/api/src/services/triggers/bond/EMMABondIngestor.js
touch apps/api/src/services/triggers/hcris/HCRISCostReportParser.js
touch apps/api/src/services/triggers/form990/Schedule990DParser.js
touch apps/api/src/services/triggers/fda/MAUDERecallIngestor.js
touch apps/api/src/services/triggers/asc/CMSASCListIngestor.js
touch apps/api/src/services/triggers/accreditation/{ACRExpiryWatcher.js,AAAHCExpiryWatcher.js,AAAASFExpiryWatcher.js,AAHAExpiryWatcher.js,IACExpiryWatcher.js}
touch apps/api/src/services/triggers/construction/CountyPermitIngestor.js
touch apps/api/src/services/triggers/leadership/LeadershipTurnoverDetector.js

# Equipment-age inference engine
mkdir -p apps/api/src/services/equipment_age/{state_registries,manufacturer_eol}
touch apps/api/src/services/equipment_age/state_registries/{TexasRadiationRegistry.js,FloridaRadiationRegistry.js,CaliforniaRadiationRegistry.js,IllinoisRadiationRegistry.js,NewYorkRadiationRegistry.js}
touch apps/api/src/services/equipment_age/manufacturer_eol/{GEHealthcareEOL.js,SiemensEOL.js,PhilipsEOL.js,CanonMedicalEOL.js,FujifilmEOL.js,HologicEOL.js}
touch apps/api/src/services/equipment_age/EquipmentAgeInferenceOrchestrator.js

# Behavioral signals
mkdir -p apps/api/src/services/behavioral
touch apps/api/src/services/behavioral/{JobPostingIngestor.js,ModalityNERTagger.js,CHNAReportIngestor.js,PressReleaseMonitor.js}

# Confidence scoring
mkdir -p apps/api/src/services/confidence
touch apps/api/src/services/confidence/{ClaimRegistry.js,ConfidenceScorer.js,ContradictionDetector.js,DecayCalculator.js}

# Vertical orchestrators
mkdir -p apps/api/src/services/verticals
touch apps/api/src/services/verticals/{ImagingCenterVertical.js,OrthopedicVertical.js,ASCVertical.js,RuralHospitalVertical.js,VeterinaryVertical.js,VerticalOrchestrator.js}

# Opportunity Inbox API + UI
touch apps/api/src/routes/opportunities.js
touch apps/api/src/controllers/OpportunityController.js
touch apps/api/src/services/opportunity/{OpportunityScorer.js,OpportunityGenerator.js,WeeklyDigestJob.js}
mkdir -p apps/web/src/pages/opportunities apps/web/src/components/opportunities
touch apps/web/src/pages/opportunities/{OpportunityInbox.jsx,OpportunityDetail.jsx}
touch apps/web/src/components/opportunities/{OpportunityCard.jsx,TriggerBadge.jsx,DecisionMakerTriangle.jsx,ConfidenceDot.jsx,BidDraftPanel.jsx}

# Seed scripts
touch database/seeds/02_vertical_modules.sql
touch database/seeds/03_source_weights.sql
touch database/seeds/04_manufacturer_eol_catalog.sql

# Run migrations
npm run migrate
npm run seed

# Backfill jobs
node apps/api/src/jobs/backfill-tier-a-sources.js --state=TX --limit=5000
node apps/api/src/jobs/compute-equipment-age.js --modality=CT
node apps/api/src/jobs/generate-opportunities.js --vertical=imaging_center --state=TX
```

---

## 9. Phased 12-Week Roadmap

| Weeks | Phase | Deliverables | Exit criteria |
|---|---|---|---|
| 1–2 | Schema foundation | Migrations 007–013 deployed to Replit dev DB; confidence-scoring functions tested with synthetic data | All 7 migrations green; `compute_claim_confidence()` returns expected values |
| 3–4 | Capital trigger engine (L3) | 5 state CON scrapers live (FL, IL, NY, MA, TX); EMMA bond ingestor; 990 Schedule D parser; FDA MAUDE feed | ≥1,000 capital_triggers rows ingested across pilot states |
| 5–6 | Equipment-age inference (L4) | TX + FL radiation registry adapters; GE / Siemens / Philips EOL catalog seeded; age inference view returns weighted estimates | ≥80% precision on a 100-facility audit set |
| 7–8 | Behavioral signals (L5) | Job posting ingestion (Adzuna API + USAJobs); ACR / AAAHC / AAHA expiry watchers; CHNA ingestor | ≥10,000 active job postings tagged with modality; ≥5,000 accreditation records with expiry dates |
| 9–10 | Confidence + Opportunity Inbox (L8) | N-source agreement scorer, contradiction detector, Opportunity Inbox UI with bid-draft generator | Inbox renders 15+ scored opportunities for Chicago Medex test account |
| 11–12 | Vertical playbooks (L7) | 5 vertical modules with weights, outreach sequences, report templates; Texas pilot launch with Chicago Medex + 2 paid prospects | First 3 reps actively using Inbox; ≥1 bid won attributed to platform trigger |

---

## 10. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| State portal layout changes break scrapers | High | Playwright + visual diff alerts; Outscraper paid fallback for top 5 states; weekly health check |
| Single-source claims wrongly marked verified | High | Hard rule: 2 independent sources required for `verified`; provisional badge in UI for single-source |
| LinkedIn / Indeed scraping ToS challenges | Medium | Use Adzuna, Jooble, USAJobs APIs; licensed Outscraper output only |
| Email deliverability hurt by aggressive sending | Medium | NEPQ-style 1:1 outreach via rep's own inbox (Gmail MCP), never bulk sends |
| Reps overwhelmed by noise | Medium | Inbox cap of 15 opportunities per rep per week; quality > quantity |
| Definitive launches broker tier | Low | Stay specialized; broker margins won't sustain $5K/month either |
| HIPAA / data-handling concern | Low | No PHI ingested; all sources are public, facility-level, non-clinical |
| GHL push pollutes production | Medium | All v1.0 BatchSyncProcessor rules retained: drafts only, rep approval required |

---

## 11. Pricing Strategy

| Tier | Monthly | Annual | Target | Includes |
|---|---|---|---|---|
| Broker Solo | $499 | $4,990 | Solo / 1–3 person broker | 1 user, 1 vertical, 1 state, 100 Opportunity Inbox cards/mo |
| Broker Pro | $1,499 | $14,990 | 5–20 rep broker / dealer | 5 users, 3 verticals, 5 states, unlimited Inbox cards, CRM push |
| Distributor | $3,999 | $39,990 | Regional distributor / OEM rep firm | 25 users, all 5 verticals, nationwide, white-label, API access |
| Enterprise | $9,999+ | Custom | OEM, GPO | Unlimited seats, custom verticals, dedicated CSM, SLA |

At Pro tier the breakeven is ≈2 won bids per year (median capital deal ~$120K at 8% margin = $9.6K). The pitch writes itself.

---

## 12. Success Metrics — 90-Day Texas Pilot

- **5,000+** Texas facilities indexed and scored across all 5 verticals
- **≥80%** precision on equipment install-year inference (audited against rep field knowledge)
- **15/week** ready-to-bid opportunities per active rep
- **3x** win-rate versus a cold list of equivalent size
- **2-source minimum verification** rate ≥ 85% on Inbox-surfaced contacts
- **≥1 won bid** attributable to a platform-detected trigger in the first 60 days

---

*Hansen Holdings · SaaS Lab · v2.0 plan published May 19, 2026*
