# Medintel OS — Data Routing

How each source CSV in the April–May 2026 drop flows through the warehouse: which staging table catches it, which production tables it feeds, and the transform that joins the two.

Run order:

1. `medintel_os_schema.sql` — once per database (creates schema, functions, ref data, tables, views).
2. `medintel_os_load.sql` — every drop (truncates staging, copies, transforms upserts). Idempotent.

## Vertical taxonomy

| Vertical  | Source files | Notes |
|---|---|---|
| HOSPITAL | `Hospital_*` files, HCRIS, PSI-11, Hospital Service Area | Hospital enrollments file was missing from this drop; CHOW + All_Owners loaded without enrollment join until it arrives. |
| FQHC     | `FQHC_*` files | Enrollments + All_Owners + Additional NPIs + Additional Addresses |
| RHC      | `RHC_*` files | Same shape as FQHC |
| SNF      | `SNF_CHOW_NPIs` only | Additional-NPI bridge rows; the SNF enrollment file is not in this drop |
| ACO      | PY 2024 ACO Results, AIP Spend Plan 2026 | Shapiro Shared Savings Program performance + spending |
| ASM      | CY27 Prelim ASM Participants | Specialty ASM rollouts CY27–CY31 |
| CMMI     | WDDSE Model Summary | CMS Innovation Center model catalog |
| DME      | DME by Geography | National + state-level DME spend by HCPCS |

## File → staging → production map

| # | Source CSV | Encoding | Rows | Staging | Production targets | Section |
|---|---|---|---|---|---|---|
| 1 | `FQHC_Enrollments_2026.04.01.csv`        | WIN1252 | 11,063 | `stage_pecos_enrollments` (vertical='FQHC')      | `dim_facility`, `bridge_npi_enrollment` (primary), `bridge_facility_address` (primary) | B.1, C.1–C.3 |
| 2 | `RHC_Enrollments_2026.04.01.csv`         | WIN1252 |  5,530 | `stage_pecos_enrollments` (vertical='RHC')       | `dim_facility`, `bridge_npi_enrollment` (primary), `bridge_facility_address` (primary) | B.1, C.1–C.3 |
| 3 | Hospital Enrollments — **NOT IN DROP**   | WIN1252 |    —   | `stage_pecos_enrollments` (vertical='HOSPITAL')  | (same as above)                                                                        | B.1 (commented out) |
| 4 | `Hospital_All_Owners_2026.05.01.csv`     | WIN1252 | 147,332 | `stage_pecos_all_owners` (vertical='HOSPITAL')  | `dim_owner`, `fact_ownership`                                                          | B.2, C.4–C.5 |
| 5 | `FQHC_All_Owners_2026.04.01.csv`         | WIN1252 | 148,919 | `stage_pecos_all_owners` (vertical='FQHC')      | `dim_owner`, `fact_ownership`                                                          | B.2, C.4–C.5 |
| 6 | `RHC_All_Owners_2026.04.01.csv`          | WIN1252 |  65,551 | `stage_pecos_all_owners` (vertical='RHC')       | `dim_owner`, `fact_ownership`                                                          | B.2, C.4–C.5 |
| 7 | `FQHC_Additional_NPIs_2026.04.01.csv`    | UTF-8   |    261 | `stage_pecos_addl_npis` (source='FQHC_AddlNPIs')         | `bridge_npi_enrollment` (secondary)                                            | B.3, C.2 |
| 8 | `RHC_Additional_NPIs_2026.04.01.csv`     | UTF-8   |    132 | `stage_pecos_addl_npis` (source='RHC_AddlNPIs')          | `bridge_npi_enrollment` (secondary)                                            | B.3, C.2 |
| 9 | `Hospital_CHOW_NPIs_2026.04.01.csv`      | UTF-8   |    460 | `stage_pecos_addl_npis` (source='Hospital_CHOW_NPIs')    | `bridge_npi_enrollment` (secondary; orphan until Hospital Enrollments load)    | B.3, C.2 |
|10 | `SNF_CHOW_NPIs_2026.04.01.csv`           | UTF-8   |     34 | `stage_pecos_addl_npis` (source='SNF_CHOW_NPIs')         | `bridge_npi_enrollment` (secondary; orphan until SNF Enrollments load)         | B.3, C.2 |
|11 | `FQHC_Additional_Addresses_2026.04.01.csv` | UTF-8 |      7 | `stage_pecos_addl_addrs` (source='FQHC_AddlAddrs')       | `bridge_facility_address` (secondary)                                          | B.4, C.3 |
|12 | `RHC_Additional_Addresses_2026.04.01.csv`  | UTF-8 |     47 | `stage_pecos_addl_addrs` (source='RHC_AddlAddrs')        | `bridge_facility_address` (secondary)                                          | B.4, C.3 |
|13 | `Hospital_CHOW_2026.04.01.csv`           | WIN1252 |    755 | `stage_chow`                                             | `fact_chow`                                                                    | B.5, C.6 |
|14 | `CostReport_2023_Final.csv`              | UTF-8   |  6,103 | `stage_cost_report`                                      | `fact_cost_report`                                                             | B.6, C.7 |
|15 | `Hospital_Service_Area_2024.csv`         | UTF-8   |  ~M    | `stage_service_area` *(provisional schema)*              | `fact_service_area`                                                            | B.7, C.8 |
|16 | `ProviderLevel_Measure_Rates_..._PSI11..._2016.csv` | UTF-8 | 3,319 | `stage_psi11`                                    | `fact_psi11` (orphan until HOSP_ID↔CCN crosswalk loaded)                       | B.8, C.9 |
|17 | `mup_dme_ry25_p05_v10_dy23_geor.csv`     | UTF-8   | 38,675 | `stage_dme_geo`                                          | `fact_dme_geo`                                                                 | B.9, C.10 |
|18 | `PY 2024 ACO Results PUF_Rerun_20250925.csv` | UTF-8 |   476 | `stage_aco_results`                                      | `dim_aco`, `fact_aco_performance` (60 typed cols + JSONB catch-all)            | B.10, C.11–C.12 |
|19 | `Advance_Investment_Payment_Spend_Plan_2026.csv` | UTF-8 | 272 | `stage_aip_spend`                                       | `fact_aip_spending` (also upserts `dim_aco`)                                   | B.11, C.11, C.13 |
|20 | `CY27_Prelim_ASMParticipants_Public.csv` | UTF-8   |  6,637 | `stage_asm`                                              | `fact_asm_participant`                                                         | B.12, C.14 |
|21 | `WDDSEModelSummaryGUIDE051926.csv`       | WIN1252 |    105 | `stage_cmmi`                                             | `dim_cmmi_model` (parses `states`/`keywords` into TEXT[])                      | B.13, C.15 |

## Transform behaviors

| Behavior | Where | Why |
|---|---|---|
| `norm_flag(TEXT) → BOOLEAN`         | every Y/N/0/1/0.0/1.0/t/f column         | Hospital All_Owners uses string Y/N; FQHC/RHC use float 1.0/0.0. Flattens both. |
| `safe_num(TEXT) → NUMERIC`          | every HCRIS / money / percentage column  | CSV values arrive as `$1,234.56`, `12%`, blank, or `N/A`. Strips noise; returns NULL on parse failure rather than aborting the whole INSERT. |
| `derive_ccn_acronym(TEXT) → VARCHAR(8)` | `dim_facility` insert                | Routes the 4-digit CCN suffix to an acronym (STH, CAH, FQHC, RHC, LTCH, REH, etc.) via `ref_ccn_acronym`. |
| Date parsing tries 3 formats        | Enrollments, CHOW, ACO start, association | CMS files mix `MM/DD/YYYY`, `YYYY-MM-DD`, and `YYYYMMDD` depending on vintage. |
| `BOOL_OR` rollup in `dim_owner`     | C.4                                       | Same owner appears across many ownership records; we keep TRUE if any record says they're PE/REIT/etc. |
| `dim_aco` populated from BOTH ACO Results AND AIP Spend Plan | C.11 | Some AIP-receiving ACOs may not appear in the Results file (e.g., terminated before PY close). |
| `fact_aco_performance.additional_fields` JSONB | C.12                       | The 130+ ACO Results columns beyond the typed set land here, queryable as `additional_fields->>'CAHPS_1'`. |
| `dim_cmmi_model.states` & `keywords` TEXT[] | C.15                            | Source is comma-separated strings; parsed into Postgres arrays so you can do `WHERE 'IL' = ANY(states)`. |
| Service-area staging schema is provisional | A.7 / B.7                        | I don't have the CSV's column header — **inspect the header line first** (`head -1 Hospital_Service_Area_2024.csv`) and adjust the staging columns before running `\copy`. |

## Encoding quick rule

PECOS files (Enrollments, All_Owners, CHOW) and the WDDSE CMMI summary are WIN1252. Everything else is UTF-8. WIN1252-encoded files in this drop:

- `Hospital_All_Owners_2026.05.01.csv`
- `FQHC_All_Owners_2026.04.01.csv`
- `RHC_All_Owners_2026.04.01.csv`
- `FQHC_Enrollments_2026.04.01.csv`
- `RHC_Enrollments_2026.04.01.csv`
- `Hospital_CHOW_2026.04.01.csv`
- `WDDSEModelSummaryGUIDE051926.csv`

## Run sequence

```bash
psql -d medintel <<'EOF'
\set data_path '/path/to/cms/files'
\i medintel_os/medintel_os_schema.sql   -- once: creates dim/fact/bridge/view tables
\i medintel_os/medintel_os_load.sql     -- per drop: stages + copies + transforms
EOF
```

The load script is idempotent — `TRUNCATE` on staging tables and `ON CONFLICT … DO UPDATE / DO NOTHING` on production tables means you can re-run it without duplicates.

## Scoring model (placeholder)

`v_medintel_facility_score` produces a 0–100 score per facility; `v_ghl_export_active_targets` filters to `>= 70` and buckets into pipeline stages. The current weights are documented placeholders — tune against real conversion data:

| Signal | Weight | Source |
|---|---|---|
| PE or REIT in ownership chain                       | +30 | `fact_ownership.is_private_equity OR .is_reit` |
| Recent CHOW (≤ 24 months)                           | +20 | `fact_chow.effective_date` |
| ACO-aligned NPI on the enrollment                   | +15 | join through `bridge_npi_enrollment` ↔ `fact_asm_participant` |
| Chain-home-office or holding-company in ownership   | +10 | `dim_owner.is_chain_home_office OR .is_holding_company` |
| PSI-11 above national average                       | +10 | `fact_psi11.rate > AVG(rate)` |
| Recent enrollment (≤ 24 months)                     | +10 | `dim_facility.source_as_of_date` |
| Facility state matches an active CMMI model state   |  +5 | `dim_cmmi_model.states` |

Activation threshold is 70; buckets are 70–79 `qualified`, 80–89 `warm`, 90+ `hot`. Below 70 → `nurture` and is excluded from `v_ghl_export_active_targets`.
