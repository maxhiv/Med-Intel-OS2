-- =====================================================================
-- MEDINTEL OS — ETL Load Script (PostgreSQL 14+)
-- Companion to: medintel_os_schema.sql, MEDINTEL_OS_DATA_ROUTING.md
--
-- Loads all 21 CSV files in the April–May 2026 project drop.
-- Pattern: CSV → stage_* (TEXT) → INSERT…SELECT with transforms → fact/dim
--
-- USAGE:
--   1. Run medintel_os_schema.sql first (creates fact/dim tables + functions).
--   2. Set :data_path to the directory containing the CSVs.
--   3. Run this file end-to-end from psql:
--        \set data_path '/path/to/cms/files'
--        \i medintel_os/medintel_os_load.sql
--
-- ENCODING NOTES:
--   The PECOS files (Enrollments, All_Owners, CHOW) and WDDSE summary are
--   encoded WIN1252 (cp1252). All other files are UTF-8. The \copy ENCODING
--   clause converts in-flight.
--
-- PSQL VARIABLE NOTE:
--   \copy is a meta-command and does NOT substitute :varname or :'varname'
--   in its FROM argument (verified on psql 16). So we \cd :data_path once
--   near the top of this script and reference each CSV by its bare relative
--   filename in every \copy below. The medintel_os/prepare_data_dir.sh
--   helper creates a symlink dir whose contents match these expected names.
-- =====================================================================

SET search_path TO medintel, public;
SET client_min_messages = WARNING;

-- Switch psql's CWD to the data dir so the relative filenames
-- on each \copy line below resolve. psql 16+ does NOT substitute
-- :'csvfile' inside \copy meta-commands, so we rely on CWD instead.
\cd :data_path


-- ============================================================
-- SECTION A — STAGING TABLE DDL
-- All columns TEXT; transforms happen in Section C.
-- Column order MUST match CSV column order exactly.
-- ============================================================

-- ---- A.1 PECOS Enrollments (Hospital/FQHC/RHC) — 21 cols ----
DROP TABLE IF EXISTS stage_pecos_enrollments;
CREATE TABLE stage_pecos_enrollments (
    enrollment_id              TEXT,
    enrollment_state           TEXT,
    provider_type_code         TEXT,
    provider_type_text         TEXT,
    npi                        TEXT,
    multiple_npi_flag          TEXT,
    ccn                        TEXT,
    associate_id               TEXT,
    organization_name          TEXT,
    doing_business_as_name     TEXT,
    incorporation_date         TEXT,
    incorporation_state        TEXT,
    organization_type_structure TEXT,
    organization_other_type_text TEXT,
    proprietary_nonprofit      TEXT,
    address_line1              TEXT,
    address_line2              TEXT,
    city                       TEXT,
    state                      TEXT,
    zip_code                   TEXT,
    telephone_number           TEXT,
    source_vertical            TEXT,   -- 'HOSPITAL' | 'FQHC' | 'RHC' — set by loader
    source_file                TEXT
);

-- ---- A.2 PECOS All_Owners (Hospital/FQHC/RHC) — 38 cols ----
DROP TABLE IF EXISTS stage_pecos_all_owners;
CREATE TABLE stage_pecos_all_owners (
    enrollment_id              TEXT,
    associate_id               TEXT,
    organization_name          TEXT,
    associate_id_owner         TEXT,
    type_owner                 TEXT,
    role_code_owner            TEXT,
    role_text_owner            TEXT,
    association_date_owner     TEXT,
    first_name_owner           TEXT,
    middle_name_owner          TEXT,
    last_name_owner            TEXT,
    title_owner                TEXT,
    organization_name_owner    TEXT,
    doing_business_as_name_owner TEXT,
    address_line1_owner        TEXT,
    address_line2_owner        TEXT,
    city_owner                 TEXT,
    state_owner                TEXT,
    zip_code_owner             TEXT,
    percentage_ownership       TEXT,
    created_for_acquisition_owner TEXT,
    corporation_owner          TEXT,
    llc_owner                  TEXT,
    medical_provider_supplier_owner TEXT,
    mgmt_services_company_owner TEXT,
    medical_staffing_company_owner TEXT,
    holding_company_owner      TEXT,
    investment_firm_owner      TEXT,
    financial_institution_owner TEXT,
    consulting_firm_owner      TEXT,
    for_profit_owner           TEXT,
    non_profit_owner           TEXT,
    private_equity_owner       TEXT,
    reit_owner                 TEXT,
    chain_home_office_owner    TEXT,
    other_type_owner           TEXT,
    other_type_text_owner      TEXT,
    owned_by_another_owner     TEXT,
    source_vertical            TEXT,
    source_file                TEXT
);

-- ---- A.3 PECOS Additional NPIs (FQHC/RHC/Hospital_CHOW/SNF_CHOW) — 2 cols ----
DROP TABLE IF EXISTS stage_pecos_addl_npis;
CREATE TABLE stage_pecos_addl_npis (
    enrollment_id              TEXT,
    npi                        TEXT,
    source_file                TEXT
);

-- ---- A.4 PECOS Additional Addresses (FQHC/RHC) — 7 cols ----
DROP TABLE IF EXISTS stage_pecos_addl_addrs;
CREATE TABLE stage_pecos_addl_addrs (
    enrollment_id              TEXT,
    address_line1              TEXT,
    address_line2              TEXT,
    city                       TEXT,
    state                      TEXT,
    zip_code                   TEXT,
    telephone_number           TEXT,
    source_file                TEXT
);

-- ---- A.5 Hospital CHOW transactions — 23 cols ----
DROP TABLE IF EXISTS stage_chow;
CREATE TABLE stage_chow (
    enrollment_id_buyer        TEXT,
    enrollment_state_buyer     TEXT,
    provider_type_code_buyer   TEXT,
    provider_type_text_buyer   TEXT,
    npi_buyer                  TEXT,
    multiple_npi_flag_buyer    TEXT,
    ccn_buyer                  TEXT,
    associate_id_buyer         TEXT,
    organization_name_buyer    TEXT,
    doing_business_as_name_buyer TEXT,
    chow_type_code             TEXT,
    chow_type_text             TEXT,
    effective_date             TEXT,
    enrollment_id_seller       TEXT,
    enrollment_state_seller    TEXT,
    provider_type_code_seller  TEXT,
    provider_type_text_seller  TEXT,
    npi_seller                 TEXT,
    multiple_npi_flag_seller   TEXT,
    ccn_seller                 TEXT,
    associate_id_seller        TEXT,
    organization_name_seller   TEXT,
    doing_business_as_name_seller TEXT
);

-- ---- A.6 HCRIS Cost Report 2023 — 117 cols ----
DROP TABLE IF EXISTS stage_cost_report;
CREATE TABLE stage_cost_report (
    rpt_rec_num                TEXT,
    provider_ccn               TEXT,
    hospital_name              TEXT,
    street_address             TEXT,
    city                       TEXT,
    state_code                 TEXT,
    zip_code                   TEXT,
    county                     TEXT,
    medicare_cbsa_number       TEXT,
    rural_versus_urban         TEXT,
    ccn_facility_type          TEXT,
    provider_type              TEXT,
    type_of_control            TEXT,
    fiscal_year_begin_date     TEXT,
    fiscal_year_end_date       TEXT,
    fte_employees_payroll      TEXT,
    number_interns_residents_fte TEXT,
    total_days_title_v         TEXT,
    total_days_title_xviii     TEXT,
    total_days_title_xix       TEXT,
    total_days_all             TEXT,
    number_of_beds             TEXT,
    total_bed_days_available   TEXT,
    total_discharges_title_v   TEXT,
    total_discharges_title_xviii TEXT,
    total_discharges_title_xix TEXT,
    total_discharges_all       TEXT,
    number_beds_with_subproviders TEXT,
    hosp_total_days_v_ap       TEXT,
    hosp_total_days_xviii_ap   TEXT,
    hosp_total_days_xix_ap     TEXT,
    hosp_total_days_all_ap     TEXT,
    hosp_number_beds_ap        TEXT,
    hosp_total_bed_days_avail_ap TEXT,
    hosp_total_discharges_v_ap TEXT,
    hosp_total_discharges_xviii_ap TEXT,
    hosp_total_discharges_xix_ap TEXT,
    hosp_total_discharges_all_ap TEXT,
    cost_of_charity_care       TEXT,
    total_bad_debt_expense     TEXT,
    cost_of_uncompensated_care TEXT,
    total_unreimbursed_care    TEXT,
    total_salaries_wsa         TEXT,
    overhead_non_salary_costs  TEXT,
    depreciation_cost          TEXT,
    total_costs                TEXT,
    inpatient_total_charges    TEXT,
    outpatient_total_charges   TEXT,
    combined_io_total_charges  TEXT,
    wage_related_costs_core    TEXT,
    wage_related_costs_rhc_fqhc TEXT,
    total_salaries_adjusted    TEXT,
    contract_labor_dpc         TEXT,
    wage_related_part_a_teaching TEXT,
    wage_related_interns_residents TEXT,
    cash_on_hand_in_banks      TEXT,
    temporary_investments      TEXT,
    notes_receivable           TEXT,
    accounts_receivable        TEXT,
    allowance_uncollectible    TEXT,
    inventory                  TEXT,
    prepaid_expenses           TEXT,
    other_current_assets       TEXT,
    total_current_assets       TEXT,
    land                       TEXT,
    land_improvements          TEXT,
    buildings                  TEXT,
    leasehold_improvements     TEXT,
    fixed_equipment            TEXT,
    major_movable_equipment    TEXT,
    minor_equipment_depreciable TEXT,
    hit_designated_assets      TEXT,
    total_fixed_assets         TEXT,
    investments                TEXT,
    other_assets               TEXT,
    total_other_assets         TEXT,
    total_assets               TEXT,
    accounts_payable           TEXT,
    salaries_wages_fees_payable TEXT,
    payroll_taxes_payable      TEXT,
    notes_loans_payable_short  TEXT,
    deferred_income            TEXT,
    other_current_liabilities  TEXT,
    total_current_liabilities  TEXT,
    mortgage_payable           TEXT,
    notes_payable              TEXT,
    unsecured_loans            TEXT,
    other_long_term_liabilities TEXT,
    total_long_term_liabilities TEXT,
    total_liabilities          TEXT,
    general_fund_balance       TEXT,
    total_fund_balances        TEXT,
    total_liab_and_fund_balances TEXT,
    drg_amounts_other_outlier  TEXT,
    drg_amounts_before_oct_1   TEXT,
    drg_amounts_after_oct_1    TEXT,
    outlier_payments_discharges TEXT,
    disproportionate_share_adj TEXT,
    allowable_dsh_percentage   TEXT,
    managed_care_simulated_pmts TEXT,
    total_ime_payment          TEXT,
    inpatient_revenue          TEXT,
    outpatient_revenue         TEXT,
    total_patient_revenue      TEXT,
    less_contractual_allowance TEXT,
    net_patient_revenue        TEXT,
    less_total_operating_expense TEXT,
    net_income_service_patients TEXT,
    total_other_income         TEXT,
    total_income               TEXT,
    total_other_expenses       TEXT,
    net_income                 TEXT,
    cost_to_charge_ratio       TEXT,
    net_revenue_medicaid       TEXT,
    medicaid_charges           TEXT,
    net_revenue_chip           TEXT,
    chip_charges               TEXT
);

-- ---- A.7 Hospital Service Area 2024 — schema is PROVISIONAL ----
-- Verify the actual CSV header before \copy; adjust columns as needed.
DROP TABLE IF EXISTS stage_service_area;
CREATE TABLE stage_service_area (
    medicare_prov_num          TEXT,
    zip_cd_of_residence        TEXT,
    total_days_of_care         TEXT,
    total_charges              TEXT,
    total_cases                TEXT,
    year                       TEXT
);
COMMENT ON TABLE stage_service_area IS
    'Column order may need adjustment after inspecting actual CSV header.';

-- ---- A.8 PSI-11 — 9 cols ----
DROP TABLE IF EXISTS stage_psi11;
CREATE TABLE stage_psi11 (
    hosp_id                    TEXT,
    adm_disc                   TEXT,
    rate                       TEXT,
    interval_lower_limit       TEXT,
    interval_higher_limit      TEXT,
    start_quarter              TEXT,
    start_date                 TEXT,
    end_quarter                TEXT,
    end_date                   TEXT
);

-- ---- A.9 DME by Geography — 18 cols ----
DROP TABLE IF EXISTS stage_dme_geo;
CREATE TABLE stage_dme_geo (
    rfrg_prvdr_geo_lvl         TEXT,
    rfrg_prvdr_geo_cd          TEXT,
    rfrg_prvdr_geo_desc        TEXT,
    rbcs_lvl                   TEXT,
    rbcs_id                    TEXT,
    rbcs_desc                  TEXT,
    hcpcs_cd                   TEXT,
    hcpcs_desc                 TEXT,
    suplr_rentl_ind            TEXT,
    tot_rfrg_prvdrs            TEXT,
    tot_suplrs                 TEXT,
    tot_suplr_benes            TEXT,
    tot_suplr_clms             TEXT,
    tot_suplr_srvcs            TEXT,
    avg_suplr_sbmtd_chrg       TEXT,
    avg_suplr_mdcr_alowd_amt   TEXT,
    avg_suplr_mdcr_pymt_amt    TEXT,
    avg_suplr_mdcr_stdzd_amt   TEXT
);

-- ---- A.10 PY 2024 ACO Results — typed staging for the columns we transform ----
DROP TABLE IF EXISTS stage_aco_results;
CREATE TABLE stage_aco_results (
    aco_id                     TEXT,
    aco_name                   TEXT,
    agree_type                 TEXT,
    agreement_period_num       TEXT,
    current_start_date         TEXT,
    current_track              TEXT,
    risk_model                 TEXT,
    assign_type                TEXT,
    snf_waiver                 TEXT,
    n_ab                       TEXT,
    sav_rate                   TEXT,
    min_sav_perc               TEXT,
    bnchmk_min_exp             TEXT,
    gen_save_loss              TEXT,
    dis_adj                    TEXT,
    impact_mid_year_termination TEXT,
    earn_save_loss             TEXT,
    dis_aff_qual               TEXT,
    met_qps                    TEXT,
    met_alt_qps                TEXT,
    met_40pctl                 TEXT,
    met_incentive              TEXT,
    met_first_year             TEXT,
    report_wi                  TEXT,
    report_ecqm_cqm_medicarecqm TEXT,
    met_ssp_quality_reporting  TEXT,
    qual_score                 TEXT,
    recvd_40p                  TEXT,
    aip                        TEXT,
    aip_balance                TEXT,
    aip_recoup                 TEXT,
    aip_owe                    TEXT,
    reg_adj                    TEXT,
    prior_sav_adj              TEXT,
    final_adj_cat              TEXT,
    updated_bnchmk             TEXT,
    guardrail                  TEXT,
    hist_bnchmk                TEXT,
    ab_tot_bnchmk              TEXT,
    ab_tot_exp                 TEXT,
    final_share_rate           TEXT,
    reduced_ss                 TEXT,
    final_loss_rate            TEXT,
    rev_exp_cat                TEXT,
    per_capita_exp_all_esrd_by1 TEXT, per_capita_exp_all_dis_by1 TEXT,
    per_capita_exp_all_agdu_by1 TEXT, per_capita_exp_all_agnd_by1 TEXT,
    per_capita_exp_all_esrd_by2 TEXT, per_capita_exp_all_dis_by2 TEXT,
    per_capita_exp_all_agdu_by2 TEXT, per_capita_exp_all_agnd_by2 TEXT,
    per_capita_exp_all_esrd_by3 TEXT, per_capita_exp_all_dis_by3 TEXT,
    per_capita_exp_all_agdu_by3 TEXT, per_capita_exp_all_agnd_by3 TEXT,
    per_capita_exp_all_esrd_py  TEXT, per_capita_exp_all_dis_py  TEXT,
    per_capita_exp_all_agdu_py  TEXT, per_capita_exp_all_agnd_py TEXT,
    per_capita_exp_total_py     TEXT,
    cms_hcc_riskscore_esrd_by1 TEXT, cms_hcc_riskscore_dis_by1 TEXT,
    cms_hcc_riskscore_agdu_by1 TEXT, cms_hcc_riskscore_agnd_by1 TEXT,
    cms_hcc_riskscore_esrd_by2 TEXT, cms_hcc_riskscore_dis_by2 TEXT,
    cms_hcc_riskscore_agdu_by2 TEXT, cms_hcc_riskscore_agnd_by2 TEXT,
    cms_hcc_riskscore_esrd_by3 TEXT, cms_hcc_riskscore_dis_by3 TEXT,
    cms_hcc_riskscore_agdu_by3 TEXT, cms_hcc_riskscore_agnd_by3 TEXT,
    cms_hcc_riskscore_esrd_py  TEXT, cms_hcc_riskscore_dis_py  TEXT,
    cms_hcc_riskscore_agdu_py  TEXT, cms_hcc_riskscore_agnd_py TEXT,
    demog_riskscore_esrd_py    TEXT, demog_riskscore_dis_py     TEXT,
    demog_riskscore_agdu_py    TEXT, demog_riskscore_agnd_py    TEXT,
    demog_riskscore_esrd_by3   TEXT, demog_riskscore_dis_by3    TEXT,
    demog_riskscore_agdu_by3   TEXT, demog_riskscore_agnd_by3   TEXT,
    rr_weight_esrd_py          TEXT, rr_weight_dis_py           TEXT,
    rr_weight_agdu_py          TEXT, rr_weight_agnd_py          TEXT,
    n_ab_year_esrd_by3         TEXT, n_ab_year_dis_by3          TEXT,
    n_ab_year_aged_dual_by3    TEXT, n_ab_year_aged_nondual_by3 TEXT,
    n_ab_year_py               TEXT, n_ab_year_esrd_py          TEXT,
    n_ab_year_dis_py           TEXT, n_ab_year_aged_dual_py     TEXT,
    n_ab_year_aged_nondual_py  TEXT, n_ab_year_dual_py          TEXT,
    n_ab_year_nondual_py       TEXT,
    n_ben_va_only              TEXT, n_ben_cba_only             TEXT,
    n_ben_cba_and_va           TEXT,
    n_ben_age_0_64             TEXT, n_ben_age_65_74            TEXT,
    n_ben_age_75_84            TEXT, n_ben_age_85plus           TEXT,
    n_ben_female               TEXT, n_ben_male                 TEXT,
    n_ben_race_white           TEXT, n_ben_race_black           TEXT,
    n_ben_race_asian           TEXT, n_ben_race_hisp            TEXT,
    n_ben_race_native          TEXT, n_ben_race_other           TEXT,
    n_ben_race_unknown         TEXT,
    capann_inp_all             TEXT, capann_inp_s_trm           TEXT,
    capann_inp_l_trm           TEXT, capann_inp_rehab           TEXT,
    capann_inp_psych           TEXT, capann_hsp                 TEXT,
    capann_snf                 TEXT, capann_opd                 TEXT,
    capann_pb                  TEXT, capann_ambpay              TEXT,
    capann_hha                 TEXT, capann_dme                 TEXT,
    adm                        TEXT, adm_s_trm                  TEXT,
    adm_l_trm                  TEXT, adm_rehab                  TEXT,
    adm_psych                  TEXT,
    p_edv_vis                  TEXT, p_edv_vis_hosp             TEXT,
    p_ct_vis                   TEXT, p_mri_vis                  TEXT,
    p_em_total                 TEXT, p_em_pcp_vis               TEXT,
    p_em_sp_vis                TEXT, p_nurse_vis                TEXT,
    p_fqhc_rhc_vis             TEXT,
    p_snf_adm                  TEXT, snf_los                    TEXT,
    snf_payperstay             TEXT,
    n_cah                      TEXT, n_fqhc                     TEXT,
    n_rhc                      TEXT, n_eta                      TEXT,
    n_hosp                     TEXT, n_fac_other                TEXT,
    n_pcp                      TEXT, n_spec                     TEXT,
    n_np                       TEXT, n_pa                       TEXT,
    n_cns                      TEXT,
    perc_dual                  TEXT, perc_lti                   TEXT,
    cahps_1                    TEXT, cahps_2                    TEXT,
    cahps_3                    TEXT, cahps_4                    TEXT,
    cahps_5                    TEXT, cahps_6                    TEXT,
    cahps_7                    TEXT, cahps_11                   TEXT,
    cahps_9                    TEXT, cahps_8                    TEXT,
    measure_479                TEXT, measure_484                TEXT,
    qualityid_318              TEXT, qualityid_110              TEXT,
    qualityid_226              TEXT,
    qualityid_134_wi           TEXT, qualityid_134_ecqm         TEXT,
    qualityid_134_mipscqm      TEXT, qualityid_134_medicarecqm  TEXT,
    qualityid_113              TEXT, qualityid_112              TEXT,
    qualityid_438              TEXT, qualityid_370              TEXT,
    qualityid_001_wi           TEXT, qualityid_001_ecqm         TEXT,
    qualityid_001_mipscqm      TEXT, qualityid_001_medicarecqm  TEXT,
    qualityid_236_wi           TEXT, qualityid_236_ecqm         TEXT,
    qualityid_236_mipscqm      TEXT, qualityid_236_medicarecqm  TEXT
);

-- ---- A.11 AIP Spend Plan 2026 — 12 cols ----
DROP TABLE IF EXISTS stage_aip_spend;
CREATE TABLE stage_aip_spend (
    aco_id                     TEXT,
    aco_name                   TEXT,
    payment_use                TEXT,
    general_spend_category     TEXT,
    general_spend_subcategory  TEXT,
    total_aip_thru_dec_2025    TEXT,
    projected_spending_2024    TEXT,
    actual_spending_2024       TEXT,
    projected_spending_2025    TEXT,
    actual_spending_2025       TEXT,
    projected_spending_2026    TEXT,
    actual_spending_2026       TEXT
);

-- ---- A.12 CY27 Prelim ASM Participants — 16 cols ----
DROP TABLE IF EXISTS stage_asm;
CREATE TABLE stage_asm (
    npi                        TEXT,
    first_name                 TEXT,
    last_name                  TEXT,
    state                      TEXT,
    asm_cohort                 TEXT,
    organization_legal_name    TEXT,
    asm_cy27_participant       TEXT,
    asm_cy27_smallpractice     TEXT,
    asm_cy28_participant       TEXT,
    asm_cy28_smallpractice     TEXT,
    asm_cy29_participant       TEXT,
    asm_cy29_smallpractice     TEXT,
    asm_cy30_participant       TEXT,
    asm_cy30_smallpractice     TEXT,
    asm_cy31_participant       TEXT,
    asm_cy31_smallpractice     TEXT
);

-- ---- A.13 WDDSE CMMI Model Summary — 15 cols ----
DROP TABLE IF EXISTS stage_cmmi;
CREATE TABLE stage_cmmi (
    model_name                 TEXT,
    stage                      TEXT,
    number_of_participants     TEXT,
    category                   TEXT,
    authority                  TEXT,
    description                TEXT,
    number_of_beneficiaries_impacted TEXT,
    number_of_physicians_impacted    TEXT,
    date_began                 TEXT,
    date_ended                 TEXT,
    states                     TEXT,
    keywords                   TEXT,
    url                        TEXT,
    display_model_summary      TEXT,
    unique_id                  TEXT
);


-- ============================================================
-- SECTION B — \copy LOAD COMMANDS
-- Each block builds the absolute CSV path with \set, then \copy.
-- ============================================================

-- ---- B.1 PECOS Enrollments (WIN1252) ----
TRUNCATE stage_pecos_enrollments;

\copy stage_pecos_enrollments (enrollment_id, enrollment_state, provider_type_code, provider_type_text, npi, multiple_npi_flag, ccn, associate_id, organization_name, doing_business_as_name, incorporation_date, incorporation_state, organization_type_structure, organization_other_type_text, proprietary_nonprofit, address_line1, address_line2, city, state, zip_code, telephone_number) FROM 'FQHC_Enrollments_2026.04.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')
UPDATE stage_pecos_enrollments SET source_vertical = 'FQHC', source_file = 'FQHC_Enrollments_2026.04.01' WHERE source_vertical IS NULL;

\copy stage_pecos_enrollments (enrollment_id, enrollment_state, provider_type_code, provider_type_text, npi, multiple_npi_flag, ccn, associate_id, organization_name, doing_business_as_name, incorporation_date, incorporation_state, organization_type_structure, organization_other_type_text, proprietary_nonprofit, address_line1, address_line2, city, state, zip_code, telephone_number) FROM 'RHC_Enrollments_2026.04.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')
UPDATE stage_pecos_enrollments SET source_vertical = 'RHC', source_file = 'RHC_Enrollments_2026.04.01' WHERE source_vertical IS NULL;

-- Hospital Enrollments — now in scope (May 2026 drop).
\copy stage_pecos_enrollments (enrollment_id, enrollment_state, provider_type_code, provider_type_text, npi, multiple_npi_flag, ccn, associate_id, organization_name, doing_business_as_name, incorporation_date, incorporation_state, organization_type_structure, organization_other_type_text, proprietary_nonprofit, address_line1, address_line2, city, state, zip_code, telephone_number) FROM 'Hospital_Enrollments_2026.05.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')
UPDATE stage_pecos_enrollments SET source_vertical = 'HOSPITAL', source_file = 'Hospital_Enrollments_2026.05.01' WHERE source_vertical IS NULL;


-- ---- B.2 PECOS All_Owners (WIN1252) ----
TRUNCATE stage_pecos_all_owners;

\copy stage_pecos_all_owners (enrollment_id, associate_id, organization_name, associate_id_owner, type_owner, role_code_owner, role_text_owner, association_date_owner, first_name_owner, middle_name_owner, last_name_owner, title_owner, organization_name_owner, doing_business_as_name_owner, address_line1_owner, address_line2_owner, city_owner, state_owner, zip_code_owner, percentage_ownership, created_for_acquisition_owner, corporation_owner, llc_owner, medical_provider_supplier_owner, mgmt_services_company_owner, medical_staffing_company_owner, holding_company_owner, investment_firm_owner, financial_institution_owner, consulting_firm_owner, for_profit_owner, non_profit_owner, private_equity_owner, reit_owner, chain_home_office_owner, other_type_owner, other_type_text_owner, owned_by_another_owner) FROM 'Hospital_All_Owners_2026.05.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')
UPDATE stage_pecos_all_owners SET source_vertical = 'HOSPITAL', source_file = 'Hospital_All_Owners_2026.05.01' WHERE source_vertical IS NULL;

\copy stage_pecos_all_owners (enrollment_id, associate_id, organization_name, associate_id_owner, type_owner, role_code_owner, role_text_owner, association_date_owner, first_name_owner, middle_name_owner, last_name_owner, title_owner, organization_name_owner, doing_business_as_name_owner, address_line1_owner, address_line2_owner, city_owner, state_owner, zip_code_owner, percentage_ownership, created_for_acquisition_owner, corporation_owner, llc_owner, medical_provider_supplier_owner, mgmt_services_company_owner, medical_staffing_company_owner, holding_company_owner, investment_firm_owner, financial_institution_owner, consulting_firm_owner, for_profit_owner, non_profit_owner, private_equity_owner, reit_owner, chain_home_office_owner, other_type_owner, other_type_text_owner, owned_by_another_owner) FROM 'FQHC_All_Owners_2026.04.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')
UPDATE stage_pecos_all_owners SET source_vertical = 'FQHC', source_file = 'FQHC_All_Owners_2026.04.01' WHERE source_vertical IS NULL;

\copy stage_pecos_all_owners (enrollment_id, associate_id, organization_name, associate_id_owner, type_owner, role_code_owner, role_text_owner, association_date_owner, first_name_owner, middle_name_owner, last_name_owner, title_owner, organization_name_owner, doing_business_as_name_owner, address_line1_owner, address_line2_owner, city_owner, state_owner, zip_code_owner, percentage_ownership, created_for_acquisition_owner, corporation_owner, llc_owner, medical_provider_supplier_owner, mgmt_services_company_owner, medical_staffing_company_owner, holding_company_owner, investment_firm_owner, financial_institution_owner, consulting_firm_owner, for_profit_owner, non_profit_owner, private_equity_owner, reit_owner, chain_home_office_owner, other_type_owner, other_type_text_owner, owned_by_another_owner) FROM 'RHC_All_Owners_2026.04.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')
UPDATE stage_pecos_all_owners SET source_vertical = 'RHC', source_file = 'RHC_All_Owners_2026.04.01' WHERE source_vertical IS NULL;


-- ---- B.3 Additional NPIs (UTF-8) ----
TRUNCATE stage_pecos_addl_npis;

\copy stage_pecos_addl_npis (enrollment_id, npi) FROM 'FQHC_Additional_NPIs_2026.04.01.csv' WITH (FORMAT csv, HEADER true)
UPDATE stage_pecos_addl_npis SET source_file = 'FQHC_AddlNPIs' WHERE source_file IS NULL;

\copy stage_pecos_addl_npis (enrollment_id, npi) FROM 'RHC_Additional_NPIs_2026.04.01.csv' WITH (FORMAT csv, HEADER true)
UPDATE stage_pecos_addl_npis SET source_file = 'RHC_AddlNPIs' WHERE source_file IS NULL;

\copy stage_pecos_addl_npis (enrollment_id, npi) FROM 'Hospital_CHOW_NPIs_2026.04.01.csv' WITH (FORMAT csv, HEADER true)
UPDATE stage_pecos_addl_npis SET source_file = 'Hospital_CHOW_NPIs' WHERE source_file IS NULL;

\copy stage_pecos_addl_npis (enrollment_id, npi) FROM 'SNF_CHOW_NPIs_2026.04.01.csv' WITH (FORMAT csv, HEADER true)
UPDATE stage_pecos_addl_npis SET source_file = 'SNF_CHOW_NPIs' WHERE source_file IS NULL;


-- ---- B.4 Additional Addresses (UTF-8) ----
TRUNCATE stage_pecos_addl_addrs;

\copy stage_pecos_addl_addrs (enrollment_id, address_line1, address_line2, city, state, zip_code, telephone_number) FROM 'FQHC_Additional_Addresses_2026.04.01.csv' WITH (FORMAT csv, HEADER true)
UPDATE stage_pecos_addl_addrs SET source_file = 'FQHC_AddlAddrs' WHERE source_file IS NULL;

\copy stage_pecos_addl_addrs (enrollment_id, address_line1, address_line2, city, state, zip_code, telephone_number) FROM 'RHC_Additional_Addresses_2026.04.01.csv' WITH (FORMAT csv, HEADER true)
UPDATE stage_pecos_addl_addrs SET source_file = 'RHC_AddlAddrs' WHERE source_file IS NULL;


-- ---- B.5 Hospital CHOW Transactions (WIN1252) ----
TRUNCATE stage_chow;
\copy stage_chow FROM 'Hospital_CHOW_2026.04.01.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')


-- ---- B.6 HCRIS Cost Report (UTF-8) ----
TRUNCATE stage_cost_report;
\copy stage_cost_report FROM 'CostReport_2023_Final.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.7 Hospital Service Area 2024 (UTF-8) ----
-- IMPORTANT: Verify column count + order against the CSV header first.
TRUNCATE stage_service_area;
\copy stage_service_area FROM 'Hospital_Service_Area_2024.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.8 PSI-11 (UTF-8) ----
TRUNCATE stage_psi11;
\copy stage_psi11 FROM 'ProviderLevel_Measure_Rates_for_AHRQ_Patient_Safety_Indicator_11__PSI11____2016.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.9 DME Geography (UTF-8) ----
TRUNCATE stage_dme_geo;
\copy stage_dme_geo FROM 'mup_dme_ry25_p05_v10_dy23_geor.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.10 PY 2024 ACO Results (UTF-8) ----
TRUNCATE stage_aco_results;
\copy stage_aco_results FROM 'PY 2024 ACO Results PUF_Rerun_20250925.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.11 AIP Spend Plan 2026 (UTF-8) ----
TRUNCATE stage_aip_spend;
\copy stage_aip_spend FROM 'Advance_Investment_Payment_Spend_Plan_2026.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.12 CY27 Prelim ASM Participants (UTF-8) ----
TRUNCATE stage_asm;
\copy stage_asm FROM 'CY27_Prelim_ASMParticipants_Public.csv' WITH (FORMAT csv, HEADER true, NULL '')


-- ---- B.13 WDDSE CMMI Model Summary (WIN1252) ----
TRUNCATE stage_cmmi;
\copy stage_cmmi FROM 'WDDSEModelSummaryGUIDE051926.csv' WITH (FORMAT csv, HEADER true, ENCODING 'WIN1252', NULL '')


-- ============================================================
-- SECTION C — TRANSFORM: staging → production
-- ============================================================

-- ---- C.1 dim_facility ←  stage_pecos_enrollments  ----
INSERT INTO dim_facility (
    enrollment_id, enrollment_state, provider_type_code, provider_type_text,
    vertical, primary_npi, multiple_npi_flag, ccn, ccn_acronym,
    associate_id, organization_name, doing_business_as_name,
    incorporation_date, incorporation_state, organization_type_structure,
    organization_other_type_text, proprietary_nonprofit,
    address_line1, address_line2, city, state, zip_code, telephone_number,
    source_file, source_as_of_date
)
SELECT
    s.enrollment_id,
    NULLIF(s.enrollment_state,'')::CHAR(2),
    s.provider_type_code,
    s.provider_type_text,
    s.source_vertical,
    NULLIF(s.npi,'')::BIGINT,
    norm_flag(s.multiple_npi_flag),
    NULLIF(s.ccn,''),
    derive_ccn_acronym(s.ccn),
    NULLIF(s.associate_id,'')::BIGINT,
    s.organization_name,
    s.doing_business_as_name,
    CASE
        WHEN s.incorporation_date ~ '^\d{4}-\d{2}-\d{2}' THEN s.incorporation_date::DATE
        WHEN s.incorporation_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.incorporation_date,'MM/DD/YYYY')
        WHEN s.incorporation_date ~ '^\d{8}$' THEN TO_DATE(s.incorporation_date,'YYYYMMDD')
        ELSE NULL
    END,
    NULLIF(s.incorporation_state,'')::CHAR(2),
    s.organization_type_structure,
    s.organization_other_type_text,
    UPPER(LEFT(NULLIF(s.proprietary_nonprofit,''),1)),
    s.address_line1,
    s.address_line2,
    s.city,
    NULLIF(s.state,'')::CHAR(2),
    LEFT(NULLIF(s.zip_code,''),10),
    s.telephone_number,
    s.source_file,
    CURRENT_DATE
FROM stage_pecos_enrollments s
WHERE s.enrollment_id IS NOT NULL
ON CONFLICT (enrollment_id) DO UPDATE SET
    primary_npi              = EXCLUDED.primary_npi,
    multiple_npi_flag        = EXCLUDED.multiple_npi_flag,
    ccn                      = EXCLUDED.ccn,
    ccn_acronym              = EXCLUDED.ccn_acronym,
    associate_id             = EXCLUDED.associate_id,
    organization_name        = EXCLUDED.organization_name,
    doing_business_as_name   = EXCLUDED.doing_business_as_name,
    address_line1            = EXCLUDED.address_line1,
    address_line2            = EXCLUDED.address_line2,
    city                     = EXCLUDED.city,
    state                    = EXCLUDED.state,
    zip_code                 = EXCLUDED.zip_code,
    telephone_number         = EXCLUDED.telephone_number,
    source_as_of_date        = CURRENT_DATE,
    loaded_at                = NOW();


-- ---- C.2 bridge_npi_enrollment ← Enrollments (primary) + Additional_NPIs (secondary) ----
INSERT INTO bridge_npi_enrollment (enrollment_id, npi, is_primary, source_file)
SELECT
    s.enrollment_id,
    NULLIF(s.npi,'')::BIGINT,
    TRUE,
    s.source_file
FROM stage_pecos_enrollments s
WHERE s.npi IS NOT NULL AND s.npi <> ''
ON CONFLICT (enrollment_id, npi) DO NOTHING;

INSERT INTO bridge_npi_enrollment (enrollment_id, npi, is_primary, source_file)
SELECT
    s.enrollment_id,
    NULLIF(s.npi,'')::BIGINT,
    FALSE,
    s.source_file
FROM stage_pecos_addl_npis s
WHERE s.npi IS NOT NULL AND s.npi <> ''
  AND EXISTS (SELECT 1 FROM dim_facility f WHERE f.enrollment_id = s.enrollment_id)
ON CONFLICT (enrollment_id, npi) DO NOTHING;


-- ---- C.3 bridge_facility_address ← Enrollments (primary) + Additional_Addresses ----
INSERT INTO bridge_facility_address (
    enrollment_id, is_primary, address_line1, address_line2, city, state, zip_code, telephone_number, source_file
)
SELECT
    s.enrollment_id, TRUE,
    s.address_line1, s.address_line2, s.city,
    NULLIF(s.state,'')::CHAR(2),
    LEFT(NULLIF(s.zip_code,''),10),
    s.telephone_number,
    s.source_file
FROM stage_pecos_enrollments s
WHERE s.enrollment_id IS NOT NULL;

INSERT INTO bridge_facility_address (
    enrollment_id, is_primary, address_line1, address_line2, city, state, zip_code, telephone_number, source_file
)
SELECT
    s.enrollment_id, FALSE,
    s.address_line1, s.address_line2, s.city,
    NULLIF(s.state,'')::CHAR(2),
    LEFT(NULLIF(s.zip_code,''),10),
    s.telephone_number,
    s.source_file
FROM stage_pecos_addl_addrs s
WHERE s.enrollment_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM dim_facility f WHERE f.enrollment_id = s.enrollment_id);


-- ---- C.4 dim_owner ← stage_pecos_all_owners (aggregated, deduped) ----
INSERT INTO dim_owner (
    associate_id_owner, owner_type,
    first_name, middle_name, last_name, title,
    organization_name, doing_business_as_name,
    address_line1, address_line2, city, state, zip_code,
    is_corporation, is_llc, is_medical_provider, is_mgmt_services,
    is_medical_staffing, is_holding_company, is_investment_firm,
    is_financial_inst, is_consulting_firm, is_for_profit, is_non_profit,
    is_private_equity, is_reit, is_chain_home_office,
    other_type_text, owned_by_another
)
SELECT
    NULLIF(s.associate_id_owner,'')::BIGINT       AS associate_id_owner,
    MAX(s.type_owner)                              AS owner_type,
    MAX(s.first_name_owner)                        AS first_name,
    MAX(s.middle_name_owner)                       AS middle_name,
    MAX(s.last_name_owner)                         AS last_name,
    MAX(s.title_owner)                             AS title,
    MAX(s.organization_name_owner)                 AS organization_name,
    MAX(s.doing_business_as_name_owner)            AS doing_business_as_name,
    MAX(s.address_line1_owner)                     AS address_line1,
    MAX(s.address_line2_owner)                     AS address_line2,
    MAX(s.city_owner)                              AS city,
    MAX(NULLIF(s.state_owner,''))::CHAR(2)         AS state,
    LEFT(MAX(NULLIF(s.zip_code_owner,'')),10)      AS zip_code,
    BOOL_OR(norm_flag(s.corporation_owner))                 AS is_corporation,
    BOOL_OR(norm_flag(s.llc_owner))                         AS is_llc,
    BOOL_OR(norm_flag(s.medical_provider_supplier_owner))   AS is_medical_provider,
    BOOL_OR(norm_flag(s.mgmt_services_company_owner))       AS is_mgmt_services,
    BOOL_OR(norm_flag(s.medical_staffing_company_owner))    AS is_medical_staffing,
    BOOL_OR(norm_flag(s.holding_company_owner))             AS is_holding_company,
    BOOL_OR(norm_flag(s.investment_firm_owner))             AS is_investment_firm,
    BOOL_OR(norm_flag(s.financial_institution_owner))       AS is_financial_inst,
    BOOL_OR(norm_flag(s.consulting_firm_owner))             AS is_consulting_firm,
    BOOL_OR(norm_flag(s.for_profit_owner))                  AS is_for_profit,
    BOOL_OR(norm_flag(s.non_profit_owner))                  AS is_non_profit,
    BOOL_OR(norm_flag(s.private_equity_owner))              AS is_private_equity,
    BOOL_OR(norm_flag(s.reit_owner))                        AS is_reit,
    BOOL_OR(norm_flag(s.chain_home_office_owner))           AS is_chain_home_office,
    MAX(s.other_type_text_owner)                            AS other_type_text,
    BOOL_OR(norm_flag(s.owned_by_another_owner))            AS owned_by_another
FROM stage_pecos_all_owners s
WHERE s.associate_id_owner IS NOT NULL AND s.associate_id_owner <> ''
GROUP BY NULLIF(s.associate_id_owner,'')::BIGINT
ON CONFLICT (associate_id_owner) DO UPDATE SET
    organization_name      = EXCLUDED.organization_name,
    doing_business_as_name = EXCLUDED.doing_business_as_name,
    address_line1          = EXCLUDED.address_line1,
    city                   = EXCLUDED.city,
    state                  = EXCLUDED.state,
    zip_code               = EXCLUDED.zip_code,
    is_private_equity      = EXCLUDED.is_private_equity     OR dim_owner.is_private_equity,
    is_reit                = EXCLUDED.is_reit               OR dim_owner.is_reit,
    is_holding_company     = EXCLUDED.is_holding_company    OR dim_owner.is_holding_company,
    is_chain_home_office   = EXCLUDED.is_chain_home_office  OR dim_owner.is_chain_home_office,
    loaded_at              = NOW();


-- ---- C.5 fact_ownership ← stage_pecos_all_owners ----
INSERT INTO fact_ownership (
    enrollment_id, associate_id_owner, role_code, role_text, owner_type,
    association_date, percentage_ownership, created_for_acquisition,
    is_corporation, is_llc, is_holding_company, is_private_equity,
    is_reit, is_chain_home_office, is_mgmt_services,
    is_for_profit, is_non_profit, source_file, source_as_of_date
)
SELECT
    s.enrollment_id,
    NULLIF(s.associate_id_owner,'')::BIGINT,
    NULLIF(s.role_code_owner,'')::INTEGER,
    s.role_text_owner,
    LEFT(NULLIF(s.type_owner,''),1),
    CASE
        WHEN s.association_date_owner ~ '^\d{4}-\d{2}-\d{2}' THEN s.association_date_owner::DATE
        WHEN s.association_date_owner ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.association_date_owner,'MM/DD/YYYY')
        WHEN s.association_date_owner ~ '^\d{8}$' THEN TO_DATE(s.association_date_owner,'YYYYMMDD')
        ELSE NULL
    END,
    NULLIF(s.percentage_ownership,'')::NUMERIC(6,2),
    norm_flag(s.created_for_acquisition_owner),
    norm_flag(s.corporation_owner),
    norm_flag(s.llc_owner),
    norm_flag(s.holding_company_owner),
    norm_flag(s.private_equity_owner),
    norm_flag(s.reit_owner),
    norm_flag(s.chain_home_office_owner),
    norm_flag(s.mgmt_services_company_owner),
    norm_flag(s.for_profit_owner),
    norm_flag(s.non_profit_owner),
    s.source_file,
    CURRENT_DATE
FROM stage_pecos_all_owners s
WHERE s.enrollment_id IS NOT NULL
  AND s.associate_id_owner IS NOT NULL AND s.associate_id_owner <> ''
  AND s.role_code_owner IS NOT NULL AND s.role_code_owner <> ''
  AND EXISTS (SELECT 1 FROM dim_facility f WHERE f.enrollment_id = s.enrollment_id)
  AND EXISTS (SELECT 1 FROM dim_owner    o WHERE o.associate_id_owner = NULLIF(s.associate_id_owner,'')::BIGINT)
ON CONFLICT (enrollment_id, associate_id_owner, role_code) DO UPDATE SET
    association_date     = EXCLUDED.association_date,
    percentage_ownership = EXCLUDED.percentage_ownership,
    source_as_of_date    = CURRENT_DATE;


-- ---- C.6 fact_chow ← stage_chow ----
INSERT INTO fact_chow (
    enrollment_id_buyer, enrollment_state_buyer, provider_type_code_buyer, provider_type_text_buyer,
    npi_buyer, multiple_npi_flag_buyer, ccn_buyer, associate_id_buyer,
    organization_name_buyer, dba_name_buyer,
    chow_type_code, chow_type_text, effective_date,
    enrollment_id_seller, enrollment_state_seller, provider_type_code_seller, provider_type_text_seller,
    npi_seller, multiple_npi_flag_seller, ccn_seller, associate_id_seller,
    organization_name_seller, dba_name_seller,
    vertical, source_file
)
SELECT
    s.enrollment_id_buyer,
    NULLIF(s.enrollment_state_buyer,'')::CHAR(2),
    s.provider_type_code_buyer,
    s.provider_type_text_buyer,
    NULLIF(s.npi_buyer,'')::BIGINT,
    norm_flag(s.multiple_npi_flag_buyer),
    NULLIF(s.ccn_buyer,''),
    NULLIF(s.associate_id_buyer,'')::BIGINT,
    s.organization_name_buyer,
    s.doing_business_as_name_buyer,
    s.chow_type_code,
    s.chow_type_text,
    CASE
        WHEN s.effective_date ~ '^\d{4}-\d{2}-\d{2}' THEN s.effective_date::DATE
        WHEN s.effective_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.effective_date,'MM/DD/YYYY')
        WHEN s.effective_date ~ '^\d{8}$' THEN TO_DATE(s.effective_date,'YYYYMMDD')
        ELSE NULL
    END,
    s.enrollment_id_seller,
    NULLIF(s.enrollment_state_seller,'')::CHAR(2),
    s.provider_type_code_seller,
    s.provider_type_text_seller,
    NULLIF(s.npi_seller,'')::BIGINT,
    norm_flag(s.multiple_npi_flag_seller),
    NULLIF(s.ccn_seller,''),
    NULLIF(s.associate_id_seller,'')::BIGINT,
    s.organization_name_seller,
    s.doing_business_as_name_seller,
    'HOSPITAL',
    'Hospital_CHOW_2026.04.01'
FROM stage_chow s
WHERE s.enrollment_id_buyer IS NOT NULL;


-- ---- C.7 fact_cost_report ← stage_cost_report ----
INSERT INTO fact_cost_report (
    rpt_rec_num, provider_ccn, hospital_name, street_address, city, state_code,
    zip_code, county, medicare_cbsa_number, rural_versus_urban, ccn_facility_type,
    provider_type, type_of_control, fiscal_year_begin_date, fiscal_year_end_date,
    fte_employees_payroll, number_interns_residents_fte,
    total_days_title_v, total_days_title_xviii, total_days_title_xix, total_days_all,
    number_of_beds, total_bed_days_available,
    total_discharges_title_v, total_discharges_title_xviii, total_discharges_title_xix, total_discharges_all,
    number_beds_with_subproviders,
    hosp_total_days_v_ap, hosp_total_days_xviii_ap, hosp_total_days_xix_ap, hosp_total_days_all_ap,
    hosp_number_beds_ap, hosp_total_bed_days_avail_ap,
    hosp_total_discharges_v_ap, hosp_total_discharges_xviii_ap, hosp_total_discharges_xix_ap, hosp_total_discharges_all_ap,
    cost_of_charity_care, total_bad_debt_expense, cost_of_uncompensated_care, total_unreimbursed_care,
    total_salaries_wsa, overhead_non_salary_costs, depreciation_cost, total_costs,
    inpatient_total_charges, outpatient_total_charges, combined_io_total_charges,
    wage_related_costs_core, wage_related_costs_rhc_fqhc, total_salaries_adjusted,
    contract_labor_dpc, wage_related_part_a_teaching, wage_related_interns_residents,
    cash_on_hand_in_banks, temporary_investments, notes_receivable, accounts_receivable,
    allowance_uncollectible, inventory, prepaid_expenses, other_current_assets, total_current_assets,
    land, land_improvements, buildings, leasehold_improvements,
    fixed_equipment, major_movable_equipment, minor_equipment_depreciable, hit_designated_assets, total_fixed_assets,
    investments, other_assets, total_other_assets, total_assets,
    accounts_payable, salaries_wages_fees_payable, payroll_taxes_payable,
    notes_loans_payable_short, deferred_income, other_current_liabilities, total_current_liabilities,
    mortgage_payable, notes_payable, unsecured_loans, other_long_term_liabilities, total_long_term_liabilities,
    total_liabilities, general_fund_balance, total_fund_balances, total_liab_and_fund_balances,
    drg_amounts_other_outlier, drg_amounts_before_oct_1, drg_amounts_after_oct_1,
    outlier_payments_discharges, disproportionate_share_adj, allowable_dsh_percentage,
    managed_care_simulated_pmts, total_ime_payment,
    inpatient_revenue, outpatient_revenue, total_patient_revenue, less_contractual_allowance,
    net_patient_revenue, less_total_operating_expense, net_income_service_patients,
    total_other_income, total_income, total_other_expenses, net_income, cost_to_charge_ratio,
    net_revenue_medicaid, medicaid_charges, net_revenue_chip, chip_charges
)
SELECT
    NULLIF(s.rpt_rec_num,'')::BIGINT,
    NULLIF(s.provider_ccn,''),
    s.hospital_name, s.street_address, s.city,
    NULLIF(s.state_code,'')::CHAR(2),
    LEFT(NULLIF(s.zip_code,''),10),
    s.county,
    safe_num(s.medicare_cbsa_number),
    LEFT(NULLIF(s.rural_versus_urban,''),1),
    s.ccn_facility_type,
    NULLIF(s.provider_type,'')::INTEGER,
    NULLIF(s.type_of_control,'')::INTEGER,
    CASE WHEN s.fiscal_year_begin_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.fiscal_year_begin_date,'MM/DD/YYYY')
         WHEN s.fiscal_year_begin_date ~ '^\d{4}-\d{2}-\d{2}'     THEN s.fiscal_year_begin_date::DATE
         ELSE NULL END,
    CASE WHEN s.fiscal_year_end_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.fiscal_year_end_date,'MM/DD/YYYY')
         WHEN s.fiscal_year_end_date ~ '^\d{4}-\d{2}-\d{2}'     THEN s.fiscal_year_end_date::DATE
         ELSE NULL END,
    safe_num(s.fte_employees_payroll), safe_num(s.number_interns_residents_fte),
    safe_num(s.total_days_title_v), safe_num(s.total_days_title_xviii),
    safe_num(s.total_days_title_xix), safe_num(s.total_days_all),
    safe_num(s.number_of_beds), safe_num(s.total_bed_days_available),
    safe_num(s.total_discharges_title_v), safe_num(s.total_discharges_title_xviii),
    safe_num(s.total_discharges_title_xix), safe_num(s.total_discharges_all),
    safe_num(s.number_beds_with_subproviders),
    safe_num(s.hosp_total_days_v_ap), safe_num(s.hosp_total_days_xviii_ap),
    safe_num(s.hosp_total_days_xix_ap), safe_num(s.hosp_total_days_all_ap),
    safe_num(s.hosp_number_beds_ap), safe_num(s.hosp_total_bed_days_avail_ap),
    safe_num(s.hosp_total_discharges_v_ap), safe_num(s.hosp_total_discharges_xviii_ap),
    safe_num(s.hosp_total_discharges_xix_ap), safe_num(s.hosp_total_discharges_all_ap),
    safe_num(s.cost_of_charity_care), safe_num(s.total_bad_debt_expense),
    safe_num(s.cost_of_uncompensated_care), safe_num(s.total_unreimbursed_care),
    safe_num(s.total_salaries_wsa), safe_num(s.overhead_non_salary_costs),
    safe_num(s.depreciation_cost), safe_num(s.total_costs),
    safe_num(s.inpatient_total_charges), safe_num(s.outpatient_total_charges),
    safe_num(s.combined_io_total_charges),
    safe_num(s.wage_related_costs_core), safe_num(s.wage_related_costs_rhc_fqhc),
    safe_num(s.total_salaries_adjusted), safe_num(s.contract_labor_dpc),
    safe_num(s.wage_related_part_a_teaching), safe_num(s.wage_related_interns_residents),
    safe_num(s.cash_on_hand_in_banks), safe_num(s.temporary_investments),
    safe_num(s.notes_receivable), safe_num(s.accounts_receivable),
    safe_num(s.allowance_uncollectible), safe_num(s.inventory),
    safe_num(s.prepaid_expenses), safe_num(s.other_current_assets),
    safe_num(s.total_current_assets),
    safe_num(s.land), safe_num(s.land_improvements), safe_num(s.buildings),
    safe_num(s.leasehold_improvements), safe_num(s.fixed_equipment),
    safe_num(s.major_movable_equipment), safe_num(s.minor_equipment_depreciable),
    safe_num(s.hit_designated_assets), safe_num(s.total_fixed_assets),
    safe_num(s.investments), safe_num(s.other_assets), safe_num(s.total_other_assets),
    safe_num(s.total_assets),
    safe_num(s.accounts_payable), safe_num(s.salaries_wages_fees_payable),
    safe_num(s.payroll_taxes_payable), safe_num(s.notes_loans_payable_short),
    safe_num(s.deferred_income), safe_num(s.other_current_liabilities),
    safe_num(s.total_current_liabilities),
    safe_num(s.mortgage_payable), safe_num(s.notes_payable),
    safe_num(s.unsecured_loans), safe_num(s.other_long_term_liabilities),
    safe_num(s.total_long_term_liabilities), safe_num(s.total_liabilities),
    safe_num(s.general_fund_balance), safe_num(s.total_fund_balances),
    safe_num(s.total_liab_and_fund_balances),
    safe_num(s.drg_amounts_other_outlier), safe_num(s.drg_amounts_before_oct_1),
    safe_num(s.drg_amounts_after_oct_1), safe_num(s.outlier_payments_discharges),
    safe_num(s.disproportionate_share_adj), safe_num(s.allowable_dsh_percentage),
    safe_num(s.managed_care_simulated_pmts), safe_num(s.total_ime_payment),
    safe_num(s.inpatient_revenue), safe_num(s.outpatient_revenue),
    safe_num(s.total_patient_revenue), safe_num(s.less_contractual_allowance),
    safe_num(s.net_patient_revenue), safe_num(s.less_total_operating_expense),
    safe_num(s.net_income_service_patients), safe_num(s.total_other_income),
    safe_num(s.total_income), safe_num(s.total_other_expenses),
    safe_num(s.net_income), safe_num(s.cost_to_charge_ratio),
    safe_num(s.net_revenue_medicaid), safe_num(s.medicaid_charges),
    safe_num(s.net_revenue_chip), safe_num(s.chip_charges)
FROM stage_cost_report s
WHERE s.rpt_rec_num IS NOT NULL AND s.rpt_rec_num <> ''
ON CONFLICT (rpt_rec_num) DO NOTHING;


-- ---- C.8 fact_service_area ← stage_service_area ----
INSERT INTO fact_service_area (ccn, zip_code, calendar_year, total_discharges, total_days, total_charges)
SELECT
    NULLIF(s.medicare_prov_num,''),
    LEFT(NULLIF(s.zip_cd_of_residence,''),5),
    COALESCE(NULLIF(s.year,'')::SMALLINT, 2024),
    safe_num(s.total_cases),
    safe_num(s.total_days_of_care),
    safe_num(s.total_charges)
FROM stage_service_area s
WHERE s.medicare_prov_num IS NOT NULL
  AND s.zip_cd_of_residence IS NOT NULL
ON CONFLICT (ccn, zip_code, calendar_year) DO UPDATE SET
    total_discharges = EXCLUDED.total_discharges,
    total_days       = EXCLUDED.total_days,
    total_charges    = EXCLUDED.total_charges;


-- ---- C.9 fact_psi11 ← stage_psi11 ----
INSERT INTO fact_psi11 (
    hosp_id, adm_disc, rate, interval_lower_limit, interval_higher_limit,
    start_quarter, start_date, end_quarter, end_date
)
SELECT
    NULLIF(s.hosp_id,'')::INTEGER,
    safe_num(s.adm_disc),
    safe_num(s.rate),
    safe_num(s.interval_lower_limit),
    safe_num(s.interval_higher_limit),
    s.start_quarter,
    CASE WHEN s.start_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.start_date,'MM/DD/YYYY')
         WHEN s.start_date ~ '^\d{4}-\d{2}-\d{2}'     THEN s.start_date::DATE
         ELSE NULL END,
    s.end_quarter,
    CASE WHEN s.end_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.end_date,'MM/DD/YYYY')
         WHEN s.end_date ~ '^\d{4}-\d{2}-\d{2}'     THEN s.end_date::DATE
         ELSE NULL END
FROM stage_psi11 s
WHERE s.hosp_id IS NOT NULL AND s.hosp_id <> ''
ON CONFLICT (hosp_id, start_quarter) DO NOTHING;


-- ---- C.10 fact_dme_geo ← stage_dme_geo ----
INSERT INTO fact_dme_geo (
    data_year, geo_lvl, geo_cd, geo_desc, rbcs_lvl, rbcs_id, rbcs_desc,
    hcpcs_cd, hcpcs_desc, suplr_rentl_ind,
    tot_rfrg_prvdrs, tot_suplrs, tot_suplr_benes, tot_suplr_clms, tot_suplr_srvcs,
    avg_suplr_sbmtd_chrg, avg_suplr_mdcr_alowd_amt,
    avg_suplr_mdcr_pymt_amt, avg_suplr_mdcr_stdzd_amt
)
SELECT
    2023,
    s.rfrg_prvdr_geo_lvl,
    s.rfrg_prvdr_geo_cd,
    s.rfrg_prvdr_geo_desc,
    s.rbcs_lvl, s.rbcs_id, s.rbcs_desc,
    s.hcpcs_cd, s.hcpcs_desc,
    LEFT(NULLIF(s.suplr_rentl_ind,''),1),
    NULLIF(s.tot_rfrg_prvdrs,'')::INTEGER,
    NULLIF(s.tot_suplrs,'')::INTEGER,
    safe_num(s.tot_suplr_benes),
    NULLIF(s.tot_suplr_clms,'')::INTEGER,
    NULLIF(s.tot_suplr_srvcs,'')::INTEGER,
    safe_num(s.avg_suplr_sbmtd_chrg),
    safe_num(s.avg_suplr_mdcr_alowd_amt),
    safe_num(s.avg_suplr_mdcr_pymt_amt),
    safe_num(s.avg_suplr_mdcr_stdzd_amt)
FROM stage_dme_geo s
WHERE s.rfrg_prvdr_geo_cd IS NOT NULL OR s.rfrg_prvdr_geo_lvl = 'National';


-- ---- C.11 dim_aco ← stage_aco_results (extract identity) + AIP backfill ----
INSERT INTO dim_aco (aco_id, aco_name, agree_type, agreement_period_num,
                     current_start_date, current_track, risk_model, assign_type, snf_waiver)
SELECT
    s.aco_id,
    s.aco_name,
    s.agree_type,
    NULLIF(s.agreement_period_num,'')::INTEGER,
    CASE WHEN s.current_start_date ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN TO_DATE(s.current_start_date,'MM/DD/YYYY')
         WHEN s.current_start_date ~ '^\d{4}-\d{2}-\d{2}'     THEN s.current_start_date::DATE
         ELSE NULL END,
    s.current_track,
    s.risk_model,
    s.assign_type,
    norm_flag(s.snf_waiver)
FROM stage_aco_results s
WHERE s.aco_id IS NOT NULL AND s.aco_id <> ''
ON CONFLICT (aco_id) DO UPDATE SET
    aco_name             = EXCLUDED.aco_name,
    current_track        = EXCLUDED.current_track,
    risk_model           = EXCLUDED.risk_model,
    agreement_period_num = EXCLUDED.agreement_period_num;

INSERT INTO dim_aco (aco_id, aco_name)
SELECT DISTINCT s.aco_id, s.aco_name
FROM stage_aip_spend s
WHERE s.aco_id IS NOT NULL AND s.aco_id <> ''
  AND NOT EXISTS (SELECT 1 FROM dim_aco a WHERE a.aco_id = s.aco_id)
ON CONFLICT (aco_id) DO NOTHING;


-- ---- C.12 fact_aco_performance ← stage_aco_results ----
INSERT INTO fact_aco_performance (
    aco_id, performance_year,
    n_ab, sav_rate, min_sav_perc, bnchmk_min_exp, gen_save_loss, earn_save_loss,
    met_qps, met_alt_qps, met_40pctl, met_incentive, met_first_year, qual_score,
    aip_flag, aip_balance, aip_recoup, aip_owe,
    reg_adj, updated_bnchmk, hist_bnchmk, ab_tot_bnchmk, ab_tot_exp, final_share_rate,
    n_cah, n_fqhc, n_rhc, n_eta, n_hosp,
    n_pcp, n_spec, n_np, n_pa, n_cns, perc_dual, rev_exp_cat,
    per_capita_exp_total_py, per_capita_exp_agnd_py, per_capita_exp_agdu_py, per_capita_exp_dis_py,
    cms_hcc_risk_agnd_py, cms_hcc_risk_agdu_py, cms_hcc_risk_dis_py,
    cap_ann_inp_all, cap_ann_hsp, cap_ann_snf, cap_ann_opd, cap_ann_pb,
    cap_ann_amb_pay, cap_ann_hha, cap_ann_dme,
    adm, p_edv_vis, p_em_total, p_em_pcp_vis, p_em_sp_vis, p_snf_adm, snf_los, snf_pay_per_stay,
    additional_fields
)
SELECT
    s.aco_id,
    2024,
    NULLIF(s.n_ab,'')::INTEGER,
    safe_num(s.sav_rate), safe_num(s.min_sav_perc),
    NULLIF(s.bnchmk_min_exp,'')::INTEGER,
    NULLIF(s.gen_save_loss,'')::INTEGER,
    NULLIF(s.earn_save_loss,'')::INTEGER,
    norm_flag(s.met_qps), norm_flag(s.met_alt_qps),
    norm_flag(s.met_40pctl), norm_flag(s.met_incentive), norm_flag(s.met_first_year),
    safe_num(s.qual_score),
    norm_flag(s.aip),
    s.aip_balance, s.aip_recoup, s.aip_owe,
    safe_num(s.reg_adj),
    NULLIF(s.updated_bnchmk,'')::BIGINT,
    NULLIF(s.hist_bnchmk,'')::BIGINT,
    NULLIF(s.ab_tot_bnchmk,'')::BIGINT,
    NULLIF(s.ab_tot_exp,'')::BIGINT,
    safe_num(s.final_share_rate),
    NULLIF(s.n_cah,'')::INTEGER,
    NULLIF(s.n_fqhc,'')::INTEGER,
    NULLIF(s.n_rhc,'')::INTEGER,
    NULLIF(s.n_eta,'')::INTEGER,
    NULLIF(s.n_hosp,'')::INTEGER,
    NULLIF(s.n_pcp,'')::INTEGER,
    NULLIF(s.n_spec,'')::INTEGER,
    NULLIF(s.n_np,'')::INTEGER,
    NULLIF(s.n_pa,'')::INTEGER,
    NULLIF(s.n_cns,'')::INTEGER,
    safe_num(s.perc_dual),
    s.rev_exp_cat,
    NULLIF(s.per_capita_exp_total_py,'')::BIGINT,
    NULLIF(s.per_capita_exp_all_agnd_py,'')::BIGINT,
    NULLIF(s.per_capita_exp_all_agdu_py,'')::BIGINT,
    NULLIF(s.per_capita_exp_all_dis_py,'')::BIGINT,
    safe_num(s.cms_hcc_riskscore_agnd_py),
    safe_num(s.cms_hcc_riskscore_agdu_py),
    safe_num(s.cms_hcc_riskscore_dis_py),
    NULLIF(s.capann_inp_all,'')::INTEGER,
    NULLIF(s.capann_hsp,'')::INTEGER,
    NULLIF(s.capann_snf,'')::INTEGER,
    NULLIF(s.capann_opd,'')::INTEGER,
    NULLIF(s.capann_pb,'')::INTEGER,
    NULLIF(s.capann_ambpay,'')::INTEGER,
    NULLIF(s.capann_hha,'')::INTEGER,
    NULLIF(s.capann_dme,'')::INTEGER,
    NULLIF(s.adm,'')::INTEGER,
    NULLIF(s.p_edv_vis,'')::INTEGER,
    NULLIF(s.p_em_total,'')::INTEGER,
    NULLIF(s.p_em_pcp_vis,'')::INTEGER,
    NULLIF(s.p_em_sp_vis,'')::INTEGER,
    NULLIF(s.p_snf_adm,'')::INTEGER,
    NULLIF(s.snf_los,'')::INTEGER,
    NULLIF(s.snf_payperstay,'')::INTEGER,
    -- jsonb_build_object caps at 100 args (50 pairs); concatenate two halves.
    jsonb_build_object(
        'Current_Track',         s.current_track,
        'Risk_Model',            s.risk_model,
        'Assign_Type',           s.assign_type,
        'DisAdj',                s.dis_adj,
        'DisAffQual',            s.dis_aff_qual,
        'Report_WI',             s.report_wi,
        'Report_eCQM',           s.report_ecqm_cqm_medicarecqm,
        'Met_SSP_qrr',           s.met_ssp_quality_reporting,
        'Recvd40p',              s.recvd_40p,
        'PriorSavAdj',           s.prior_sav_adj,
        'FinalAdjCat',           s.final_adj_cat,
        'Guardrail',             s.guardrail,
        'ReducedSS',             s.reduced_ss,
        'FinalLossRate',         s.final_loss_rate,
        'Impact_Mid_Year_Termination', s.impact_mid_year_termination,
        'Demog_RiskScore_AGND_PY', s.demog_riskscore_agnd_py,
        'Demog_RiskScore_AGDU_PY', s.demog_riskscore_agdu_py,
        'Demog_RiskScore_DIS_PY',  s.demog_riskscore_dis_py,
        'N_Ben_VA_Only',         s.n_ben_va_only,
        'N_Ben_CBA_Only',        s.n_ben_cba_only,
        'N_Ben_CBA_and_VA',      s.n_ben_cba_and_va,
        'N_Ben_Age_0_64',        s.n_ben_age_0_64,
        'N_Ben_Age_65_74',       s.n_ben_age_65_74,
        'N_Ben_Age_75_84',       s.n_ben_age_75_84,
        'N_Ben_Age_85plus',      s.n_ben_age_85plus,
        'N_Ben_Female',          s.n_ben_female,
        'N_Ben_Male',            s.n_ben_male,
        'N_Ben_Race_White',      s.n_ben_race_white,
        'N_Ben_Race_Black',      s.n_ben_race_black,
        'N_Ben_Race_Asian',      s.n_ben_race_asian,
        'N_Ben_Race_Hisp',       s.n_ben_race_hisp,
        'P_CT_VIS',              s.p_ct_vis,
        'P_MRI_VIS',             s.p_mri_vis,
        'P_EDV_Vis_HOSP',        s.p_edv_vis_hosp,
        'P_Nurse_Vis',           s.p_nurse_vis,
        'P_FQHC_RHC_Vis',        s.p_fqhc_rhc_vis,
        'Perc_LTI',              s.perc_lti,
        'CAHPS_1',  s.cahps_1,
        'CAHPS_2',  s.cahps_2,
        'CAHPS_3',  s.cahps_3,
        'CAHPS_4',  s.cahps_4,
        'CAHPS_5',  s.cahps_5,
        'CAHPS_6',  s.cahps_6,
        'CAHPS_7',  s.cahps_7,
        'CAHPS_8',  s.cahps_8,
        'CAHPS_9',  s.cahps_9,
        'CAHPS_11', s.cahps_11,
        'Measure_479', s.measure_479,
        'Measure_484', s.measure_484
    ) || jsonb_build_object(
        'QualityID_318',           s.qualityid_318,
        'QualityID_110',           s.qualityid_110,
        'QualityID_226',           s.qualityid_226,
        'QualityID_113',           s.qualityid_113,
        'QualityID_112',           s.qualityid_112,
        'QualityID_438',           s.qualityid_438,
        'QualityID_370',           s.qualityid_370,
        'QualityID_134_WI',        s.qualityid_134_wi,
        'QualityID_134_eCQM',      s.qualityid_134_ecqm,
        'QualityID_134_MIPSCQM',   s.qualityid_134_mipscqm,
        'QualityID_134_MedicareCQM', s.qualityid_134_medicarecqm,
        'QualityID_001_WI',        s.qualityid_001_wi,
        'QualityID_001_eCQM',      s.qualityid_001_ecqm,
        'QualityID_001_MIPSCQM',   s.qualityid_001_mipscqm,
        'QualityID_001_MedicareCQM', s.qualityid_001_medicarecqm,
        'QualityID_236_WI',        s.qualityid_236_wi,
        'QualityID_236_eCQM',      s.qualityid_236_ecqm,
        'QualityID_236_MIPSCQM',   s.qualityid_236_mipscqm,
        'QualityID_236_MedicareCQM', s.qualityid_236_medicarecqm,
        'N_AB_Year_PY',            s.n_ab_year_py,
        'N_AB_Year_Dual_PY',       s.n_ab_year_dual_py,
        'N_AB_Year_NonDual_PY',    s.n_ab_year_nondual_py
    )
FROM stage_aco_results s
WHERE s.aco_id IS NOT NULL AND s.aco_id <> ''
ON CONFLICT (aco_id, performance_year) DO NOTHING;


-- ---- C.13 fact_aip_spending ← stage_aip_spend ----
INSERT INTO fact_aip_spending (
    aco_id, payment_use, general_spend_category, general_spend_subcategory,
    total_aip_received_thru_dec_2025,
    projected_spending_2024, actual_spending_2024,
    projected_spending_2025, actual_spending_2025,
    projected_spending_2026, actual_spending_2026
)
SELECT
    s.aco_id,
    s.payment_use,
    s.general_spend_category,
    s.general_spend_subcategory,
    s.total_aip_thru_dec_2025,
    safe_num(s.projected_spending_2024), safe_num(s.actual_spending_2024),
    safe_num(s.projected_spending_2025), safe_num(s.actual_spending_2025),
    safe_num(s.projected_spending_2026), safe_num(s.actual_spending_2026)
FROM stage_aip_spend s
WHERE s.aco_id IS NOT NULL AND s.aco_id <> ''
  AND EXISTS (SELECT 1 FROM dim_aco a WHERE a.aco_id = s.aco_id);


-- ---- C.14 fact_asm_participant ← stage_asm ----
INSERT INTO fact_asm_participant (
    npi, first_name, last_name, state, asm_cohort, organization_legal_name,
    asm_cy27_participant, asm_cy27_smallpractice,
    asm_cy28_participant, asm_cy28_smallpractice,
    asm_cy29_participant, asm_cy29_smallpractice,
    asm_cy30_participant, asm_cy30_smallpractice,
    asm_cy31_participant, asm_cy31_smallpractice
)
SELECT
    NULLIF(s.npi,'')::BIGINT,
    s.first_name, s.last_name,
    NULLIF(s.state,'')::CHAR(2),
    s.asm_cohort,
    s.organization_legal_name,
    norm_flag(s.asm_cy27_participant),  norm_flag(s.asm_cy27_smallpractice),
    norm_flag(s.asm_cy28_participant),  norm_flag(s.asm_cy28_smallpractice),
    norm_flag(s.asm_cy29_participant),  norm_flag(s.asm_cy29_smallpractice),
    norm_flag(s.asm_cy30_participant),  norm_flag(s.asm_cy30_smallpractice),
    norm_flag(s.asm_cy31_participant),  norm_flag(s.asm_cy31_smallpractice)
FROM stage_asm s
WHERE s.npi IS NOT NULL AND s.npi <> ''
  AND s.asm_cohort IS NOT NULL AND s.asm_cohort <> ''
ON CONFLICT (npi, asm_cohort) DO UPDATE SET
    asm_cy27_participant   = EXCLUDED.asm_cy27_participant,
    asm_cy27_smallpractice = EXCLUDED.asm_cy27_smallpractice,
    asm_cy28_participant   = EXCLUDED.asm_cy28_participant,
    asm_cy28_smallpractice = EXCLUDED.asm_cy28_smallpractice,
    asm_cy29_participant   = EXCLUDED.asm_cy29_participant,
    asm_cy29_smallpractice = EXCLUDED.asm_cy29_smallpractice,
    asm_cy30_participant   = EXCLUDED.asm_cy30_participant,
    asm_cy30_smallpractice = EXCLUDED.asm_cy30_smallpractice,
    asm_cy31_participant   = EXCLUDED.asm_cy31_participant,
    asm_cy31_smallpractice = EXCLUDED.asm_cy31_smallpractice;


-- ---- C.15 dim_cmmi_model ← stage_cmmi ----
INSERT INTO dim_cmmi_model (
    unique_id, model_name, stage, number_of_participants, category, authority,
    description, number_of_beneficiaries_impacted, number_of_physicians_impacted,
    date_began, date_ended, states, keywords, url, display_model_summary
)
SELECT
    NULLIF(s.unique_id,'')::INTEGER,
    s.model_name, s.stage, s.number_of_participants, s.category, s.authority,
    s.description,
    safe_num(s.number_of_beneficiaries_impacted),
    safe_num(s.number_of_physicians_impacted),
    NULLIF(s.date_began,'')::INTEGER,
    NULLIF(s.date_ended,'')::INTEGER,
    CASE WHEN s.states IS NULL OR s.states = '' THEN NULL
         ELSE STRING_TO_ARRAY(REGEXP_REPLACE(s.states,'\s*,\s*',',','g'),',')
    END,
    CASE WHEN s.keywords IS NULL OR s.keywords = '' THEN NULL
         ELSE STRING_TO_ARRAY(REGEXP_REPLACE(s.keywords,'\s*,\s*',',','g'),',')
    END,
    s.url,
    norm_flag(s.display_model_summary)
FROM stage_cmmi s
WHERE s.unique_id IS NOT NULL AND s.unique_id <> ''
ON CONFLICT (unique_id) DO UPDATE SET
    model_name = EXCLUDED.model_name,
    stage      = EXCLUDED.stage,
    states     = EXCLUDED.states,
    keywords   = EXCLUDED.keywords,
    url        = EXCLUDED.url;


-- ============================================================
-- SECTION D — VERIFICATION
-- ============================================================

-- Staging row-count expectations
SELECT 'stage_pecos_enrollments' AS tbl, COUNT(*) AS n,
       '16,593 expected (11,063 FQHC + 5,530 RHC; Hospital not in drop)' AS expected FROM stage_pecos_enrollments
UNION ALL SELECT 'stage_pecos_all_owners',  COUNT(*),  '361,802 (147,332 Hosp + 148,919 FQHC + 65,551 RHC)'  FROM stage_pecos_all_owners
UNION ALL SELECT 'stage_pecos_addl_npis',   COUNT(*),  '887 (261 FQHC + 132 RHC + 460 HospCHOW + 34 SNFCHOW)' FROM stage_pecos_addl_npis
UNION ALL SELECT 'stage_pecos_addl_addrs',  COUNT(*),  '54 (7 FQHC + 47 RHC)'                                FROM stage_pecos_addl_addrs
UNION ALL SELECT 'stage_chow',              COUNT(*),  '755 Hospital CHOW transactions'                       FROM stage_chow
UNION ALL SELECT 'stage_cost_report',       COUNT(*),  '6,103 hospitals'                                     FROM stage_cost_report
UNION ALL SELECT 'stage_psi11',             COUNT(*),  '3,319 hospital-quarters'                             FROM stage_psi11
UNION ALL SELECT 'stage_dme_geo',           COUNT(*),  '38,675 geo×HCPCS combinations'                       FROM stage_dme_geo
UNION ALL SELECT 'stage_aco_results',       COUNT(*),  '476 ACOs'                                            FROM stage_aco_results
UNION ALL SELECT 'stage_aip_spend',         COUNT(*),  '272 spending line items'                             FROM stage_aip_spend
UNION ALL SELECT 'stage_asm',               COUNT(*),  '6,637 ASM participants'                              FROM stage_asm
UNION ALL SELECT 'stage_cmmi',              COUNT(*),  '105 CMMI models'                                     FROM stage_cmmi;

-- Production row counts after transform
SELECT 'dim_facility'           AS tbl, COUNT(*) FROM dim_facility
UNION ALL SELECT 'dim_owner',               COUNT(*) FROM dim_owner
UNION ALL SELECT 'dim_aco',                 COUNT(*) FROM dim_aco
UNION ALL SELECT 'dim_cmmi_model',          COUNT(*) FROM dim_cmmi_model
UNION ALL SELECT 'bridge_npi_enrollment',   COUNT(*) FROM bridge_npi_enrollment
UNION ALL SELECT 'bridge_facility_address', COUNT(*) FROM bridge_facility_address
UNION ALL SELECT 'fact_ownership',          COUNT(*) FROM fact_ownership
UNION ALL SELECT 'fact_chow',               COUNT(*) FROM fact_chow
UNION ALL SELECT 'fact_cost_report',        COUNT(*) FROM fact_cost_report
UNION ALL SELECT 'fact_service_area',       COUNT(*) FROM fact_service_area
UNION ALL SELECT 'fact_psi11',              COUNT(*) FROM fact_psi11
UNION ALL SELECT 'fact_dme_geo',            COUNT(*) FROM fact_dme_geo
UNION ALL SELECT 'fact_aco_performance',    COUNT(*) FROM fact_aco_performance
UNION ALL SELECT 'fact_aip_spending',       COUNT(*) FROM fact_aip_spending
UNION ALL SELECT 'fact_asm_participant',    COUNT(*) FROM fact_asm_participant;

-- Spot-check: PE / REIT / holding / chain owner counts
SELECT
    COUNT(*) FILTER (WHERE is_private_equity)     AS pe_owners,
    COUNT(*) FILTER (WHERE is_reit)               AS reit_owners,
    COUNT(*) FILTER (WHERE is_holding_company)    AS holding_owners,
    COUNT(*) FILTER (WHERE is_chain_home_office)  AS chain_owners
FROM dim_owner;

-- Spot-check: top-10 chains by facility count
SELECT chain_name, facilities_owned, states_present, verticals
FROM v_chain_ownership
ORDER BY facilities_owned DESC
LIMIT 10;

-- Spot-check: facilities at/above the 70-point activation threshold by pipeline stage
SELECT
    pipeline_stage,
    COUNT(*) AS facilities
FROM v_ghl_export_active_targets
GROUP BY pipeline_stage
ORDER BY MIN(medintel_score) DESC;

-- =====================================================================
-- END OF LOAD SCRIPT
-- =====================================================================
