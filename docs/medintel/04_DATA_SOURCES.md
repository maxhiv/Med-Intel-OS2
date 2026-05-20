# 04 — Data Source Catalog

Every Tier-A and Tier-B source MedIntel v2.0 ingests, with access pattern, URL, rate limits, and source weight.

---

## Tier A — Primary capital trigger signals

### 1. State Certificate of Need (CON) filings

| State | Portal | Format | Access | Build priority |
|---|---|---|---|---|
| Florida | https://apps.ahca.myflorida.com/dm_web/ | HTML | Scrape (Playwright) | Phase 2 |
| Illinois | https://hfsrb.illinois.gov/permits/applications | HTML + PDF | Scrape | Phase 2 |
| New York | https://apps.health.ny.gov/pubdoh/professionals/doctors/conduct/factions | HTML | Scrape | Phase 2 |
| Massachusetts | https://www.mass.gov/lists/determination-of-need-applications | HTML + PDF | Scrape | Phase 2 |
| Texas | https://www.dshs.texas.gov/regulatory-licensing-units | HTML | Scrape | Phase 2 (pilot priority) |
| North Carolina | https://info.ncdhhs.gov/dhsr/coneed/conpro.htm | HTML + PDF | Scrape | Phase 2 stretch |
| Alabama | https://shpda.alabama.gov/applications-and-decisions/ | HTML + PDF | Scrape | Phase 2 stretch |
| Maryland | https://mhcc.maryland.gov/mhcc/pages/hcfs/hcfs_con/hcfs_con.aspx | HTML | Scrape | Phase 6 |
| New Jersey | https://www.nj.gov/health/healthfacilities/certificate-of-need/ | HTML | Scrape | Phase 6 |
| Other 26 states | Varies | Varies | Scrape | Phase 6+ |

**Build pattern:** `BaseCONScraper` abstract class + per-state subclasses. All write to the `con_filings` table (existing v1.0) AND `capital_triggers` (new v2.0 — Migration 008).

**Rate limits:** Most state portals have no documented rate limit. Cap at 1 req/sec to be polite. Cache aggressively.

**Source weight:** 0.90 (state filing, attorney-reviewed, public record)

---

### 2. CMS HCRIS Medicare Cost Reports

| Detail | Value |
|---|---|
| URL | https://www.cms.gov/data-research/statistics-trends-and-reports/cost-reports/hospital-2010-form |
| Format | CSV bulk download (multi-GB per fiscal year) |
| Cadence | Quarterly refresh by CMS |
| Key worksheets | A-7 (Movable Equipment), G-1 (Balance Sheet), S-3 Part I (Inpatient Days) |
| Source weight | 0.85 |

**Build pattern:** Bulk download nightly, parse Worksheet A-7 for each provider, compute depreciation percentage per asset class. Movable equipment >70% depreciated = high replacement signal.

---

### 3. EMMA Municipal Bond filings (MSRB)

| Detail | Value |
|---|---|
| URL | https://emma.msrb.org/Search/Search.aspx |
| API | https://emma.msrb.org/Help/EMMADataServices.aspx (paid tier) |
| Format | Free tier: HTML scrape; paid tier: structured API |
| Key documents | Official Statements (OS), Annual Continuing Disclosures (ACD) |
| Source weight | 0.85 |

**Build pattern:** Search by CUSIP-9 prefix for healthcare obligor types. Extract "Use of Proceeds" and "Capital Equipment Plan" sections from Official Statements. Parse PDF with `pdf-parse` or Anthropic Sonnet 4 vision.

---

### 4. IRS Form 990 — Schedule D and Schedule H

| Detail | Value |
|---|---|
| URL | https://apps.irs.gov/app/eos/ + https://projects.propublica.org/nonprofits/api/v2 |
| Format | XML (IRS) + JSON (ProPublica) |
| Cadence | Annual filing, 12–18 month lag |
| Schedule D | Asset detail (capital equipment) |
| Schedule H | Hospital-specific reporting incl. CHNA |
| Source weight | 0.80 |

**Build pattern:** Use ProPublica's free Nonprofit Explorer API for the index, then download raw 990 XML for facilities of interest. Parse Schedule D Section B (Investments — Other Securities) and Section C (Investments — Program Related) for capital equipment lines. Already partially ingested in v1.0; extend in Phase 2.

---

### 5. State radiation control program registries

| State | Portal | Format | Access |
|---|---|---|---|
| Texas | https://www.dshs.texas.gov/radiation-control | Lookup form | Scrape per facility |
| Florida | https://www.floridahealth.gov/programs-and-services/community-health/radiation-control | PDF facility lookup | Scrape |
| California | https://www.cdph.ca.gov/Programs/CEH/DRSEM/Pages/RHB-MachineDB.aspx | HTML | Scrape |
| Illinois | https://emergency.illinois.gov/operations/radiation-safety.html | PDF index | Scrape |
| New York | https://www.health.ny.gov/environmental/radiological/ | HTML | Scrape |

**Build pattern:** Per-state adapter. Input: facility NPI + name. Output: `equipment_age_evidence` rows with `evidence_type = 'state_registry'`, `evidence_weight = 0.95`, install year + serial.

**Source weight:** 0.95 (highest — government, ground truth)

**Build priority:** TX and FL first (Phase 3 — Chicago Medex pilot is Texas)

---

### 6. FDA MAUDE recalls + OpenFDA

| Detail | Value |
|---|---|
| API | https://api.fda.gov/device/recall.json |
| Format | JSON, free, no auth |
| Rate limit | 240 req/min, 120K req/day |
| Source weight | 0.90 |

**Build pattern:** Daily pull of new recalls. For each Class I/II recall on a capital equipment device class (radiology, surgery, ortho), match `device_name` and `manufacturer` against `equipment_records`. Insert `capital_triggers` row with `category = 'fda_recall'`.

---

### 7. CMS ASC Covered Procedures List

| Detail | Value |
|---|---|
| URL | https://www.cms.gov/medicare/medicare-fee-for-service-payment/ascpayment |
| Format | Annual Addendum AA + BB (CSV / Excel) |
| Cadence | CMS publishes annual update each November for January effective date |
| Source weight | 0.95 |

**Build pattern:** Annual ingestion. Diff against prior year's list. For every CPT newly payable in ASC setting, identify all ASCs in that specialty (via existing `procedure_volumes` and `facilities` joins) and emit `capital_triggers` rows.

---

### 8. ACR / IAC / AAAHC / AAAASF / AAHA accreditation expiry

| Body | Lookup | Format |
|---|---|---|
| ACR | https://www.acraccreditation.org/lookup | HTML search by ZIP/city |
| IAC | https://www.intersocietal.org/iac/find-a-facility | HTML |
| AAAHC | https://www.aaahc.org/accreditation/find-an-accredited-organization/ | HTML |
| AAAASF | https://www.aaasf.org/facility-search | HTML |
| AAHA | https://www.aaha.org/your-pet/find-an-accredited-hospital/ | HTML |

**Build pattern:** One adapter per body. Crawl periodically, match to `facilities` by name + city + state, populate `accreditation_records` (Migration 010). Watch for `expires_at` within 12 months → emit `capital_triggers` row.

**Source weight:** 0.85

---

## Tier B — Behavioral / context signals

### 9. Job postings — Adzuna, Jooble, USAJobs

| Source | API | Free tier | Rate limit |
|---|---|---|---|
| Adzuna | https://developer.adzuna.com/ | 25 req/min, 1K req/day on free | Yes |
| Jooble | https://jooble.org/api/about | 500 req/day on free | Yes |
| USAJobs | https://developer.usajobs.gov/ | Unlimited, requires email key | Yes |

**Build pattern:** Search by healthcare keywords (`MRI Technologist`, `CT Tech`, `Mammographer`, `C-arm Tech`, `Robotic Surgery Coordinator`, `Biomedical Equipment Technician`). Modality NER tagger extracts modality from title + description. Aggregate by facility + week → emit `behavioral_signals` row with hiring velocity.

**Source weight:** 0.30 single posting, 0.65 velocity ≥3 in 60 days

---

### 10. Press releases and news monitoring

| Source | Access | Rate limit |
|---|---|---|
| NewsAPI | https://newsapi.org/ | 100 req/day free |
| GDELT | https://www.gdeltproject.org/ | Free, unlimited |
| Google News RSS | Per-query RSS | Unlimited |

**Build pattern:** Query by facility name from `facilities` table. Filter for capital-equipment-relevant phrases ("breaks ground", "new wing", "expansion", "imaging center", "surgical robot", "modernization"). Emit `capital_triggers` row with `category = 'press_release'`, `signal_strength = 0.55`.

**Source weight:** 0.55 (self-reported)

---

### 11. HRSA rural hospital + USDA rural development

| Source | URL | Format |
|---|---|---|
| HRSA Rural Hospital Stabilization Program | https://www.ruralhealthinfo.org/funding | HTML grant lists |
| HRSA Small Rural Hospital Improvement Program (SHIP) | https://www.hrsa.gov/rural-health/grants/rural-hospitals/small-hospital-improvement | HTML award lists |
| USDA Rural Development Community Facilities | https://www.rd.usda.gov/programs-services/community-facilities | HTML awarded loan lists |
| HRSA OPAIS 340B | https://opaisapps.hrsa.gov/OPAIS/ | HTML search |

**Build pattern:** Per-program ingestor. Match by facility NPI / name / city / state to `facilities`. Emit `capital_triggers` with `category in ('usda_loan', 'hrsa_grant')`.

**Source weight:** 0.90

---

### 12. CHNA reports

**Source:** Hospital websites (every tax-exempt hospital must publish per IRS §501(r)) + IRS Form 990 Schedule H.

**Build pattern:** Crawl `/community-health-needs-assessment/` and similar URL patterns on hospital websites. Use Claude Sonnet 4 to extract identified service / equipment gaps. Emit `capital_triggers` with `category = 'chna_gap'`.

**Source weight:** 0.75

---

### 13. Construction permits

| Source | Coverage | Access |
|---|---|---|
| County / city building departments | Local | Per-jurisdiction scrape |
| BuildZoom | Aggregated | Paid API |
| SmartProcure | Aggregated | Paid |
| OpenPermits | Open data | Free for participating cities |

**Build pattern:** Phase 6 — start with the top 20 counties by hospital density. Free OpenPermits where available; aggregator paid tier where not.

**Source weight:** 0.60

---

## Tier C — Vertical-specific

### 14. CMS Physician Compare (ortho procedure volumes)

| Detail | Value |
|---|---|
| URL | https://data.cms.gov/provider-data/dataset/x4uw-szc8 |
| Format | CSV |
| Source weight | 0.90 |

CPT 27447 (total knee), CPT 27130 (total hip), CPT 22633 (lumbar fusion), CPT 23472 (total shoulder).

---

### 15. CMS Critical Access Hospital list

| Detail | Value |
|---|---|
| URL | https://data.cms.gov/provider-data/dataset/yv7e-xc69 |
| Format | CSV |
| Source weight | 0.95 |

The 1,360 CAH facilities, refreshed monthly. Maps directly to the rural hospital vertical.

---

### 16. USDA APHIS veterinary facility licensing

| Detail | Value |
|---|---|
| URL | https://aphis.my.site.com/PublicSearchTool/s/ |
| Format | HTML search |
| Source weight | 0.75 |

---

### 17. Veterinary consolidator hierarchies

Maintain a hand-curated `veterinary_consolidators` table:

| Consolidator | Locations | Notes |
|---|---|---|
| Mars Veterinary Health | ≈2,500 | Banfield, VCA, BluePearl, AntechDiagnostics — centralized procurement |
| National Veterinary Associates (NVA) | ≈1,500 | Centralized but more autonomy per location |
| Pathway Vet Alliance | ≈400 | Acquired by TSG Consumer Partners |
| PetVet Care Centers | ≈400 | KKR-owned |
| BluePearl Veterinary Partners | (under Mars) | Specialty + ER |
| MedVet | ≈40 | Specialty + ER |
| VetCor | ≈400 | Roll-up |

When a consolidator buys a practice, all locations re-enter a capital refresh window. Track acquisition press releases.

---

## API key allocation matrix

| Service | Required env vars | Default | Approval gate? |
|---|---|---|---|
| Adzuna | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ADZUNA_ENABLED` | disabled | Yes (free tier limits) |
| Jooble | `JOOBLE_API_KEY`, `JOOBLE_ENABLED` | disabled | Yes |
| USAJobs | `USAJOBS_EMAIL`, `USAJOBS_API_KEY`, `USAJOBS_ENABLED` | disabled | Yes |
| NewsAPI | `NEWSAPI_KEY`, `NEWSAPI_ENABLED` | disabled | Yes |
| GDELT | none | always on | No |
| FDA OpenFDA | none | always on | No |
| ProPublica 990 | none | always on | No |
| State CON portals | none (scrape) | always on | No |
| State radiation registries | none (scrape) | always on | No |
| HCRIS bulk | none | always on | No |
| EMMA | none (scrape free tier) | always on | No |

Free + scraped sources have no env gate. Paid APIs use the same dual-gate as v1.0.

---

*Updated for v2.0 handoff · May 19, 2026 · Always check the source URL — government portals change layout regularly.*
