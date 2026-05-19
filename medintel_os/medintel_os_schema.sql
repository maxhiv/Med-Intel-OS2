-- =====================================================================
-- MEDINTEL OS — Warehouse Schema (PostgreSQL 14+)
-- Companion to: medintel_os_load.sql, MEDINTEL_OS_DATA_ROUTING.md
--
-- Run ONCE per database (before medintel_os_load.sql).
-- Idempotent: every CREATE uses IF NOT EXISTS / OR REPLACE.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS medintel;
SET search_path TO medintel, public;
SET client_min_messages = WARNING;

-- =====================================================================
-- HELPER FUNCTIONS
-- =====================================================================

-- norm_flag: collapses Y/N, 0/1, 0.0/1.0, t/f, true/false, blank → BOOLEAN
CREATE OR REPLACE FUNCTION norm_flag(p TEXT) RETURNS BOOLEAN AS $$
BEGIN
    IF p IS NULL THEN RETURN NULL; END IF;
    CASE LOWER(BTRIM(p))
        WHEN ''      THEN RETURN NULL;
        WHEN 'y'     THEN RETURN TRUE;
        WHEN 'n'     THEN RETURN FALSE;
        WHEN 'yes'   THEN RETURN TRUE;
        WHEN 'no'    THEN RETURN FALSE;
        WHEN 't'     THEN RETURN TRUE;
        WHEN 'f'     THEN RETURN FALSE;
        WHEN 'true'  THEN RETURN TRUE;
        WHEN 'false' THEN RETURN FALSE;
        WHEN '1'     THEN RETURN TRUE;
        WHEN '0'     THEN RETURN FALSE;
        WHEN '1.0'   THEN RETURN TRUE;
        WHEN '0.0'   THEN RETURN FALSE;
        ELSE RETURN NULL;
    END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- safe_num: strip $, commas, %, handle blank / N/A / NULL → NUMERIC
CREATE OR REPLACE FUNCTION safe_num(p TEXT) RETURNS NUMERIC AS $$
BEGIN
    IF p IS NULL OR BTRIM(p) = '' OR p ILIKE 'n/a' OR p ILIKE 'null' THEN
        RETURN NULL;
    END IF;
    RETURN REPLACE(REPLACE(REPLACE(BTRIM(p), '$', ''), ',', ''), '%', '')::NUMERIC;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =====================================================================
-- REFERENCE TABLES
-- =====================================================================

-- CCN numeric-range → facility-type acronym (Medicare State Operations Manual).
-- Last 4 digits of a standard 6-char CCN map into one of these ranges.
CREATE TABLE IF NOT EXISTS ref_ccn_acronym (
    range_low   INTEGER NOT NULL,
    range_high  INTEGER NOT NULL,
    acronym     VARCHAR(8) NOT NULL,
    description TEXT,
    PRIMARY KEY (range_low, range_high)
);

INSERT INTO ref_ccn_acronym (range_low, range_high, acronym, description) VALUES
    (   1,  879, 'STH',     'Short-Term (Acute Care) Hospital'),
    ( 900,  999, 'STH',     'Multiple Hospital Component'),
    (1000, 1299, 'RHC',     'Hospital-Based Rural Health Clinic'),
    (1300, 1399, 'CAH',     'Critical Access Hospital'),
    (1400, 1499, 'CAH',     'Critical Access Hospital (renumbered)'),
    (1500, 1799, 'HOSPICE', 'Hospice'),
    (1800, 1989, 'FQHC',    'Federally Qualified Health Center'),
    (1990, 1999, 'REH',     'Rural Emergency Hospital'),
    (2000, 2299, 'LTCH',    'Long-Term Care Hospital'),
    (2300, 2499, 'LTCH',    'Long-Term Care Hospital (renumbered)'),
    (3025, 3099, 'REHAB',   'Inpatient Rehabilitation Facility'),
    (3100, 3199, 'REHAB',   'Inpatient Rehabilitation Facility (renumbered)'),
    (3300, 3399, 'CHLDN',   'Children''s Hospital'),
    (3500, 3699, 'STH',     'Short-Term Hospital (Indian Health Service)'),
    (3800, 3999, 'RHC',     'Rural Health Clinic (provider-based)'),
    (4000, 4499, 'PSY',     'Psychiatric Hospital'),
    (4500, 4599, 'PSY',     'Psychiatric Hospital (renumbered)'),
    (5000, 6499, 'SNF',     'Skilled Nursing Facility'),
    (6500, 6989, 'SNF',     'Skilled Nursing Facility (renumbered)'),
    (6990, 6999, 'ICF/IID', 'Intermediate Care Facility / Intellectual Disability'),
    (7000, 8499, 'HHA',     'Home Health Agency'),
    (8500, 8999, 'RHC',     'Rural Health Clinic (independent)'),
    (9000, 9799, 'ESRD',    'End-Stage Renal Disease Facility'),
    (9800, 9899, 'ASC',     'Ambulatory Surgical Center')
ON CONFLICT (range_low, range_high) DO UPDATE SET
    acronym     = EXCLUDED.acronym,
    description = EXCLUDED.description;

-- derive_ccn_acronym: route last-4-digits of a CCN to its acronym
CREATE OR REPLACE FUNCTION derive_ccn_acronym(p TEXT) RETURNS VARCHAR(8) AS $$
DECLARE
    suffix INTEGER;
    result VARCHAR(8);
BEGIN
    IF p IS NULL OR LENGTH(BTRIM(p)) = 0 THEN
        RETURN NULL;
    END IF;
    BEGIN
        -- Last 4 digits of the CCN; some PECOS files include alpha suffixes
        suffix := RIGHT(REGEXP_REPLACE(p, '\D', '', 'g'), 4)::INTEGER;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
    SELECT acronym INTO result
    FROM ref_ccn_acronym
    WHERE suffix BETWEEN range_low AND range_high
    ORDER BY (range_high - range_low) ASC
    LIMIT 1;
    RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================================
-- DIMENSION TABLES
-- =====================================================================

CREATE TABLE IF NOT EXISTS dim_facility (
    enrollment_id                TEXT PRIMARY KEY,
    enrollment_state             CHAR(2),
    provider_type_code           TEXT,
    provider_type_text           TEXT,
    vertical                     TEXT,
    primary_npi                  BIGINT,
    multiple_npi_flag            BOOLEAN,
    ccn                          TEXT,
    ccn_acronym                  VARCHAR(8),
    associate_id                 BIGINT,
    organization_name            TEXT,
    doing_business_as_name       TEXT,
    incorporation_date           DATE,
    incorporation_state          CHAR(2),
    organization_type_structure  TEXT,
    organization_other_type_text TEXT,
    proprietary_nonprofit        CHAR(1),
    address_line1                TEXT,
    address_line2                TEXT,
    city                         TEXT,
    state                        CHAR(2),
    zip_code                     VARCHAR(10),
    telephone_number             TEXT,
    source_file                  TEXT,
    source_as_of_date            DATE,
    loaded_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_dim_facility_ccn      ON dim_facility (ccn);
CREATE INDEX IF NOT EXISTS ix_dim_facility_npi      ON dim_facility (primary_npi);
CREATE INDEX IF NOT EXISTS ix_dim_facility_associd  ON dim_facility (associate_id);
CREATE INDEX IF NOT EXISTS ix_dim_facility_state    ON dim_facility (state);
CREATE INDEX IF NOT EXISTS ix_dim_facility_vertical ON dim_facility (vertical);

CREATE TABLE IF NOT EXISTS dim_owner (
    associate_id_owner     BIGINT PRIMARY KEY,
    owner_type             TEXT,
    first_name             TEXT,
    middle_name            TEXT,
    last_name              TEXT,
    title                  TEXT,
    organization_name      TEXT,
    doing_business_as_name TEXT,
    address_line1          TEXT,
    address_line2          TEXT,
    city                   TEXT,
    state                  CHAR(2),
    zip_code               VARCHAR(10),
    is_corporation         BOOLEAN,
    is_llc                 BOOLEAN,
    is_medical_provider    BOOLEAN,
    is_mgmt_services       BOOLEAN,
    is_medical_staffing    BOOLEAN,
    is_holding_company     BOOLEAN,
    is_investment_firm     BOOLEAN,
    is_financial_inst      BOOLEAN,
    is_consulting_firm     BOOLEAN,
    is_for_profit          BOOLEAN,
    is_non_profit          BOOLEAN,
    is_private_equity      BOOLEAN,
    is_reit                BOOLEAN,
    is_chain_home_office   BOOLEAN,
    other_type_text        TEXT,
    owned_by_another       BOOLEAN,
    loaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_dim_owner_org_name ON dim_owner (organization_name);
CREATE INDEX IF NOT EXISTS ix_dim_owner_pe       ON dim_owner (is_private_equity) WHERE is_private_equity;
CREATE INDEX IF NOT EXISTS ix_dim_owner_reit     ON dim_owner (is_reit)           WHERE is_reit;
CREATE INDEX IF NOT EXISTS ix_dim_owner_chain    ON dim_owner (is_chain_home_office) WHERE is_chain_home_office;

CREATE TABLE IF NOT EXISTS dim_aco (
    aco_id               TEXT PRIMARY KEY,
    aco_name             TEXT,
    agree_type           TEXT,
    agreement_period_num INTEGER,
    current_start_date   DATE,
    current_track        TEXT,
    risk_model           TEXT,
    assign_type          TEXT,
    snf_waiver           BOOLEAN
);

CREATE TABLE IF NOT EXISTS dim_cmmi_model (
    unique_id                        INTEGER PRIMARY KEY,
    model_name                       TEXT,
    stage                            TEXT,
    number_of_participants           TEXT,
    category                         TEXT,
    authority                        TEXT,
    description                      TEXT,
    number_of_beneficiaries_impacted NUMERIC,
    number_of_physicians_impacted    NUMERIC,
    date_began                       INTEGER,
    date_ended                       INTEGER,
    states                           TEXT[],
    keywords                         TEXT[],
    url                              TEXT,
    display_model_summary            BOOLEAN
);
CREATE INDEX IF NOT EXISTS ix_dim_cmmi_states_gin   ON dim_cmmi_model USING GIN (states);
CREATE INDEX IF NOT EXISTS ix_dim_cmmi_keywords_gin ON dim_cmmi_model USING GIN (keywords);

-- =====================================================================
-- BRIDGE TABLES
-- =====================================================================

CREATE TABLE IF NOT EXISTS bridge_npi_enrollment (
    enrollment_id TEXT   NOT NULL REFERENCES dim_facility(enrollment_id) ON DELETE CASCADE,
    npi           BIGINT NOT NULL,
    is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
    source_file   TEXT,
    loaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (enrollment_id, npi)
);
CREATE INDEX IF NOT EXISTS ix_bridge_npi_npi ON bridge_npi_enrollment (npi);

CREATE TABLE IF NOT EXISTS bridge_facility_address (
    address_pk       BIGSERIAL PRIMARY KEY,
    enrollment_id    TEXT NOT NULL REFERENCES dim_facility(enrollment_id) ON DELETE CASCADE,
    is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
    address_line1    TEXT,
    address_line2    TEXT,
    city             TEXT,
    state            CHAR(2),
    zip_code         VARCHAR(10),
    telephone_number TEXT,
    source_file      TEXT,
    loaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_bridge_addr_enrollment ON bridge_facility_address (enrollment_id);
CREATE INDEX IF NOT EXISTS ix_bridge_addr_zip        ON bridge_facility_address (zip_code);

-- =====================================================================
-- FACT TABLES
-- =====================================================================

CREATE TABLE IF NOT EXISTS fact_ownership (
    enrollment_id          TEXT    NOT NULL REFERENCES dim_facility(enrollment_id) ON DELETE CASCADE,
    associate_id_owner     BIGINT  NOT NULL REFERENCES dim_owner(associate_id_owner) ON DELETE CASCADE,
    role_code              INTEGER NOT NULL,
    role_text              TEXT,
    owner_type             CHAR(1),
    association_date       DATE,
    percentage_ownership   NUMERIC(6,2),
    created_for_acquisition BOOLEAN,
    is_corporation         BOOLEAN,
    is_llc                 BOOLEAN,
    is_holding_company     BOOLEAN,
    is_private_equity      BOOLEAN,
    is_reit                BOOLEAN,
    is_chain_home_office   BOOLEAN,
    is_mgmt_services       BOOLEAN,
    is_for_profit          BOOLEAN,
    is_non_profit          BOOLEAN,
    source_file            TEXT,
    source_as_of_date      DATE,
    PRIMARY KEY (enrollment_id, associate_id_owner, role_code)
);
CREATE INDEX IF NOT EXISTS ix_fact_own_owner ON fact_ownership (associate_id_owner);
CREATE INDEX IF NOT EXISTS ix_fact_own_pe    ON fact_ownership (is_private_equity) WHERE is_private_equity;
CREATE INDEX IF NOT EXISTS ix_fact_own_reit  ON fact_ownership (is_reit)            WHERE is_reit;

CREATE TABLE IF NOT EXISTS fact_chow (
    chow_pk                    BIGSERIAL PRIMARY KEY,
    enrollment_id_buyer        TEXT,
    enrollment_state_buyer     CHAR(2),
    provider_type_code_buyer   TEXT,
    provider_type_text_buyer   TEXT,
    npi_buyer                  BIGINT,
    multiple_npi_flag_buyer    BOOLEAN,
    ccn_buyer                  TEXT,
    associate_id_buyer         BIGINT,
    organization_name_buyer    TEXT,
    dba_name_buyer             TEXT,
    chow_type_code             TEXT,
    chow_type_text             TEXT,
    effective_date             DATE,
    enrollment_id_seller       TEXT,
    enrollment_state_seller    CHAR(2),
    provider_type_code_seller  TEXT,
    provider_type_text_seller  TEXT,
    npi_seller                 BIGINT,
    multiple_npi_flag_seller   BOOLEAN,
    ccn_seller                 TEXT,
    associate_id_seller        BIGINT,
    organization_name_seller   TEXT,
    dba_name_seller            TEXT,
    vertical                   TEXT,
    source_file                TEXT,
    loaded_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_fact_chow_buyer  ON fact_chow (enrollment_id_buyer);
CREATE INDEX IF NOT EXISTS ix_fact_chow_seller ON fact_chow (enrollment_id_seller);
CREATE INDEX IF NOT EXISTS ix_fact_chow_date   ON fact_chow (effective_date);
CREATE INDEX IF NOT EXISTS ix_fact_chow_ccn_b  ON fact_chow (ccn_buyer);

CREATE TABLE IF NOT EXISTS fact_cost_report (
    rpt_rec_num                    BIGINT PRIMARY KEY,
    provider_ccn                   TEXT,
    hospital_name                  TEXT,
    street_address                 TEXT,
    city                           TEXT,
    state_code                     CHAR(2),
    zip_code                       VARCHAR(10),
    county                         TEXT,
    medicare_cbsa_number           NUMERIC,
    rural_versus_urban             CHAR(1),
    ccn_facility_type              TEXT,
    provider_type                  INTEGER,
    type_of_control                INTEGER,
    fiscal_year_begin_date         DATE,
    fiscal_year_end_date           DATE,
    fte_employees_payroll          NUMERIC,
    number_interns_residents_fte   NUMERIC,
    total_days_title_v             NUMERIC,
    total_days_title_xviii         NUMERIC,
    total_days_title_xix           NUMERIC,
    total_days_all                 NUMERIC,
    number_of_beds                 NUMERIC,
    total_bed_days_available       NUMERIC,
    total_discharges_title_v       NUMERIC,
    total_discharges_title_xviii   NUMERIC,
    total_discharges_title_xix     NUMERIC,
    total_discharges_all           NUMERIC,
    number_beds_with_subproviders  NUMERIC,
    hosp_total_days_v_ap           NUMERIC,
    hosp_total_days_xviii_ap       NUMERIC,
    hosp_total_days_xix_ap         NUMERIC,
    hosp_total_days_all_ap         NUMERIC,
    hosp_number_beds_ap            NUMERIC,
    hosp_total_bed_days_avail_ap   NUMERIC,
    hosp_total_discharges_v_ap     NUMERIC,
    hosp_total_discharges_xviii_ap NUMERIC,
    hosp_total_discharges_xix_ap   NUMERIC,
    hosp_total_discharges_all_ap   NUMERIC,
    cost_of_charity_care           NUMERIC,
    total_bad_debt_expense         NUMERIC,
    cost_of_uncompensated_care     NUMERIC,
    total_unreimbursed_care        NUMERIC,
    total_salaries_wsa             NUMERIC,
    overhead_non_salary_costs      NUMERIC,
    depreciation_cost              NUMERIC,
    total_costs                    NUMERIC,
    inpatient_total_charges        NUMERIC,
    outpatient_total_charges       NUMERIC,
    combined_io_total_charges      NUMERIC,
    wage_related_costs_core        NUMERIC,
    wage_related_costs_rhc_fqhc    NUMERIC,
    total_salaries_adjusted        NUMERIC,
    contract_labor_dpc             NUMERIC,
    wage_related_part_a_teaching   NUMERIC,
    wage_related_interns_residents NUMERIC,
    cash_on_hand_in_banks          NUMERIC,
    temporary_investments          NUMERIC,
    notes_receivable               NUMERIC,
    accounts_receivable            NUMERIC,
    allowance_uncollectible        NUMERIC,
    inventory                      NUMERIC,
    prepaid_expenses               NUMERIC,
    other_current_assets           NUMERIC,
    total_current_assets           NUMERIC,
    land                           NUMERIC,
    land_improvements              NUMERIC,
    buildings                      NUMERIC,
    leasehold_improvements         NUMERIC,
    fixed_equipment                NUMERIC,
    major_movable_equipment        NUMERIC,
    minor_equipment_depreciable    NUMERIC,
    hit_designated_assets          NUMERIC,
    total_fixed_assets             NUMERIC,
    investments                    NUMERIC,
    other_assets                   NUMERIC,
    total_other_assets             NUMERIC,
    total_assets                   NUMERIC,
    accounts_payable               NUMERIC,
    salaries_wages_fees_payable    NUMERIC,
    payroll_taxes_payable          NUMERIC,
    notes_loans_payable_short      NUMERIC,
    deferred_income                NUMERIC,
    other_current_liabilities      NUMERIC,
    total_current_liabilities      NUMERIC,
    mortgage_payable               NUMERIC,
    notes_payable                  NUMERIC,
    unsecured_loans                NUMERIC,
    other_long_term_liabilities    NUMERIC,
    total_long_term_liabilities    NUMERIC,
    total_liabilities              NUMERIC,
    general_fund_balance           NUMERIC,
    total_fund_balances            NUMERIC,
    total_liab_and_fund_balances   NUMERIC,
    drg_amounts_other_outlier      NUMERIC,
    drg_amounts_before_oct_1       NUMERIC,
    drg_amounts_after_oct_1        NUMERIC,
    outlier_payments_discharges    NUMERIC,
    disproportionate_share_adj     NUMERIC,
    allowable_dsh_percentage       NUMERIC,
    managed_care_simulated_pmts    NUMERIC,
    total_ime_payment              NUMERIC,
    inpatient_revenue              NUMERIC,
    outpatient_revenue             NUMERIC,
    total_patient_revenue          NUMERIC,
    less_contractual_allowance     NUMERIC,
    net_patient_revenue            NUMERIC,
    less_total_operating_expense   NUMERIC,
    net_income_service_patients    NUMERIC,
    total_other_income             NUMERIC,
    total_income                   NUMERIC,
    total_other_expenses           NUMERIC,
    net_income                     NUMERIC,
    cost_to_charge_ratio           NUMERIC,
    net_revenue_medicaid           NUMERIC,
    medicaid_charges               NUMERIC,
    net_revenue_chip               NUMERIC,
    chip_charges                   NUMERIC,
    loaded_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_fact_cost_ccn   ON fact_cost_report (provider_ccn);
CREATE INDEX IF NOT EXISTS ix_fact_cost_state ON fact_cost_report (state_code);

CREATE TABLE IF NOT EXISTS fact_service_area (
    ccn              TEXT     NOT NULL,
    zip_code         VARCHAR(5) NOT NULL,
    calendar_year    SMALLINT  NOT NULL,
    total_discharges NUMERIC,
    total_days       NUMERIC,
    total_charges    NUMERIC,
    PRIMARY KEY (ccn, zip_code, calendar_year)
);
CREATE INDEX IF NOT EXISTS ix_fact_sa_zip ON fact_service_area (zip_code);

CREATE TABLE IF NOT EXISTS fact_psi11 (
    hosp_id               INTEGER NOT NULL,
    adm_disc              NUMERIC,
    rate                  NUMERIC,
    interval_lower_limit  NUMERIC,
    interval_higher_limit NUMERIC,
    start_quarter         TEXT    NOT NULL,
    start_date            DATE,
    end_quarter           TEXT,
    end_date              DATE,
    PRIMARY KEY (hosp_id, start_quarter)
);

CREATE TABLE IF NOT EXISTS fact_dme_geo (
    dme_pk                   BIGSERIAL PRIMARY KEY,
    data_year                SMALLINT NOT NULL,
    geo_lvl                  TEXT,
    geo_cd                   TEXT,
    geo_desc                 TEXT,
    rbcs_lvl                 TEXT,
    rbcs_id                  TEXT,
    rbcs_desc                TEXT,
    hcpcs_cd                 TEXT,
    hcpcs_desc               TEXT,
    suplr_rentl_ind          CHAR(1),
    tot_rfrg_prvdrs          INTEGER,
    tot_suplrs               INTEGER,
    tot_suplr_benes          NUMERIC,
    tot_suplr_clms           INTEGER,
    tot_suplr_srvcs          INTEGER,
    avg_suplr_sbmtd_chrg     NUMERIC,
    avg_suplr_mdcr_alowd_amt NUMERIC,
    avg_suplr_mdcr_pymt_amt  NUMERIC,
    avg_suplr_mdcr_stdzd_amt NUMERIC
);
CREATE INDEX IF NOT EXISTS ix_fact_dme_hcpcs ON fact_dme_geo (hcpcs_cd);
CREATE INDEX IF NOT EXISTS ix_fact_dme_geo   ON fact_dme_geo (geo_lvl, geo_cd);

CREATE TABLE IF NOT EXISTS fact_aco_performance (
    aco_id               TEXT     NOT NULL REFERENCES dim_aco(aco_id) ON DELETE CASCADE,
    performance_year     SMALLINT NOT NULL,
    n_ab                 INTEGER,
    sav_rate             NUMERIC,
    min_sav_perc         NUMERIC,
    bnchmk_min_exp       INTEGER,
    gen_save_loss        INTEGER,
    earn_save_loss       INTEGER,
    met_qps              BOOLEAN,
    met_alt_qps          BOOLEAN,
    met_40pctl           BOOLEAN,
    met_incentive        BOOLEAN,
    met_first_year       BOOLEAN,
    qual_score           NUMERIC,
    aip_flag             BOOLEAN,
    aip_balance          TEXT,
    aip_recoup           TEXT,
    aip_owe              TEXT,
    reg_adj              NUMERIC,
    updated_bnchmk       BIGINT,
    hist_bnchmk          BIGINT,
    ab_tot_bnchmk        BIGINT,
    ab_tot_exp           BIGINT,
    final_share_rate     NUMERIC,
    n_cah                INTEGER,
    n_fqhc               INTEGER,
    n_rhc                INTEGER,
    n_eta                INTEGER,
    n_hosp               INTEGER,
    n_pcp                INTEGER,
    n_spec               INTEGER,
    n_np                 INTEGER,
    n_pa                 INTEGER,
    n_cns                INTEGER,
    perc_dual            NUMERIC,
    rev_exp_cat          TEXT,
    per_capita_exp_total_py BIGINT,
    per_capita_exp_agnd_py  BIGINT,
    per_capita_exp_agdu_py  BIGINT,
    per_capita_exp_dis_py   BIGINT,
    cms_hcc_risk_agnd_py    NUMERIC,
    cms_hcc_risk_agdu_py    NUMERIC,
    cms_hcc_risk_dis_py     NUMERIC,
    cap_ann_inp_all      INTEGER,
    cap_ann_hsp          INTEGER,
    cap_ann_snf          INTEGER,
    cap_ann_opd          INTEGER,
    cap_ann_pb           INTEGER,
    cap_ann_amb_pay      INTEGER,
    cap_ann_hha          INTEGER,
    cap_ann_dme          INTEGER,
    adm                  INTEGER,
    p_edv_vis            INTEGER,
    p_em_total           INTEGER,
    p_em_pcp_vis         INTEGER,
    p_em_sp_vis          INTEGER,
    p_snf_adm            INTEGER,
    snf_los              INTEGER,
    snf_pay_per_stay     INTEGER,
    additional_fields    JSONB,
    PRIMARY KEY (aco_id, performance_year)
);
CREATE INDEX IF NOT EXISTS ix_fact_aco_perf_addl_gin ON fact_aco_performance USING GIN (additional_fields);

CREATE TABLE IF NOT EXISTS fact_aip_spending (
    aip_pk                            BIGSERIAL PRIMARY KEY,
    aco_id                            TEXT NOT NULL REFERENCES dim_aco(aco_id) ON DELETE CASCADE,
    payment_use                       TEXT,
    general_spend_category            TEXT,
    general_spend_subcategory         TEXT,
    total_aip_received_thru_dec_2025  TEXT,
    projected_spending_2024           NUMERIC,
    actual_spending_2024              NUMERIC,
    projected_spending_2025           NUMERIC,
    actual_spending_2025              NUMERIC,
    projected_spending_2026           NUMERIC,
    actual_spending_2026              NUMERIC
);
CREATE INDEX IF NOT EXISTS ix_fact_aip_aco ON fact_aip_spending (aco_id);

CREATE TABLE IF NOT EXISTS fact_asm_participant (
    npi                     BIGINT  NOT NULL,
    first_name              TEXT,
    last_name               TEXT,
    state                   CHAR(2),
    asm_cohort              TEXT    NOT NULL,
    organization_legal_name TEXT,
    asm_cy27_participant    BOOLEAN,
    asm_cy27_smallpractice  BOOLEAN,
    asm_cy28_participant    BOOLEAN,
    asm_cy28_smallpractice  BOOLEAN,
    asm_cy29_participant    BOOLEAN,
    asm_cy29_smallpractice  BOOLEAN,
    asm_cy30_participant    BOOLEAN,
    asm_cy30_smallpractice  BOOLEAN,
    asm_cy31_participant    BOOLEAN,
    asm_cy31_smallpractice  BOOLEAN,
    PRIMARY KEY (npi, asm_cohort)
);
CREATE INDEX IF NOT EXISTS ix_fact_asm_state ON fact_asm_participant (state);

-- =====================================================================
-- VIEWS
-- =====================================================================

-- v_chain_ownership: one row per chain-home-office owner, summarizing reach.
CREATE OR REPLACE VIEW v_chain_ownership AS
SELECT
    COALESCE(o.organization_name,
             TRIM(CONCAT_WS(' ', o.first_name, o.last_name)),
             'UNKNOWN')                                                 AS chain_name,
    o.associate_id_owner                                                AS chain_associate_id,
    COUNT(DISTINCT fo.enrollment_id)                                    AS facilities_owned,
    ARRAY(SELECT DISTINCT f.state
            FROM dim_facility f
            JOIN fact_ownership x ON x.enrollment_id = f.enrollment_id
           WHERE x.associate_id_owner = o.associate_id_owner
             AND f.state IS NOT NULL
           ORDER BY f.state)                                            AS states_present,
    ARRAY(SELECT DISTINCT f.vertical
            FROM dim_facility f
            JOIN fact_ownership x ON x.enrollment_id = f.enrollment_id
           WHERE x.associate_id_owner = o.associate_id_owner
             AND f.vertical IS NOT NULL
           ORDER BY f.vertical)                                         AS verticals,
    BOOL_OR(fo.is_private_equity)                                       AS any_pe_link,
    BOOL_OR(fo.is_reit)                                                 AS any_reit_link,
    o.is_chain_home_office                                              AS flagged_chain_home_office
FROM dim_owner o
JOIN fact_ownership fo USING (associate_id_owner)
WHERE COALESCE(o.is_chain_home_office, FALSE)
   OR COALESCE(o.is_holding_company,   FALSE)
   OR COALESCE(o.is_private_equity,    FALSE)
   OR COALESCE(o.is_reit,              FALSE)
GROUP BY o.associate_id_owner, o.organization_name, o.first_name, o.last_name,
         o.is_chain_home_office
HAVING COUNT(DISTINCT fo.enrollment_id) >= 2;

COMMENT ON VIEW v_chain_ownership IS
    'Owners controlling 2+ facilities (chain home office, holding company, PE, or REIT). '
    'Reach is computed from fact_ownership joined to dim_facility.';

-- v_medintel_facility_score: per-facility activation score (0-100).
-- Documented baseline; tune weights as the business definition matures.
--   +30 PE or REIT ownership signal
--   +20 CHOW transaction within last 24 months
--   +15 ACO participation by an aligned NPI
--   +10 Chain home office owner
--   +10 PSI-11 above national rate
--   +10 Recent enrollment (within 24 months)
--    +5 CMMI model active in facility's state
-- The 70-point activation threshold mirrors what v_ghl_export_active_targets exports.
CREATE OR REPLACE VIEW v_medintel_facility_score AS
WITH chow_recent AS (
    SELECT enrollment_id_buyer AS enrollment_id, MAX(effective_date) AS last_chow_date
      FROM fact_chow
     WHERE effective_date >= (CURRENT_DATE - INTERVAL '24 months')
     GROUP BY enrollment_id_buyer
),
pe_reit AS (
    SELECT DISTINCT fo.enrollment_id
      FROM fact_ownership fo
     WHERE fo.is_private_equity OR fo.is_reit
),
chain_owned AS (
    SELECT DISTINCT fo.enrollment_id
      FROM fact_ownership fo
      JOIN dim_owner o USING (associate_id_owner)
     WHERE o.is_chain_home_office OR o.is_holding_company
),
aco_aligned AS (
    SELECT DISTINCT f.enrollment_id
      FROM dim_facility f
      JOIN bridge_npi_enrollment b ON b.enrollment_id = f.enrollment_id
      JOIN fact_asm_participant a   ON a.npi = b.npi
),
psi11_hot AS (
    SELECT DISTINCT f.enrollment_id
      FROM dim_facility f
      JOIN fact_psi11 p
        ON p.hosp_id::TEXT = REGEXP_REPLACE(COALESCE(f.ccn, ''), '\D', '', 'g')
     WHERE p.rate > (SELECT AVG(rate) FROM fact_psi11)
),
cmmi_states AS (
    SELECT DISTINCT UNNEST(states) AS st FROM dim_cmmi_model
)
SELECT
    f.enrollment_id,
    f.organization_name,
    f.vertical,
    f.state,
    f.ccn,
    f.ccn_acronym,
    (CASE WHEN pe.enrollment_id    IS NOT NULL THEN 30 ELSE 0 END
   + CASE WHEN ch.enrollment_id    IS NOT NULL THEN 10 ELSE 0 END
   + CASE WHEN cr.enrollment_id    IS NOT NULL THEN 20 ELSE 0 END
   + CASE WHEN aa.enrollment_id    IS NOT NULL THEN 15 ELSE 0 END
   + CASE WHEN ph.enrollment_id    IS NOT NULL THEN 10 ELSE 0 END
   + CASE WHEN f.source_as_of_date >= (CURRENT_DATE - INTERVAL '24 months') THEN 10 ELSE 0 END
   + CASE WHEN f.state IN (SELECT st FROM cmmi_states) THEN 5 ELSE 0 END)::SMALLINT AS medintel_score,
    CASE WHEN pe.enrollment_id IS NOT NULL THEN TRUE ELSE FALSE END AS has_pe_reit,
    CASE WHEN ch.enrollment_id IS NOT NULL THEN TRUE ELSE FALSE END AS has_chain_owner,
    cr.last_chow_date,
    aa.enrollment_id IS NOT NULL AS has_aco_npi_overlap,
    ph.enrollment_id IS NOT NULL AS psi11_above_avg
FROM dim_facility f
LEFT JOIN pe_reit      pe USING (enrollment_id)
LEFT JOIN chain_owned  ch USING (enrollment_id)
LEFT JOIN chow_recent  cr USING (enrollment_id)
LEFT JOIN aco_aligned  aa USING (enrollment_id)
LEFT JOIN psi11_hot    ph USING (enrollment_id);

COMMENT ON VIEW v_medintel_facility_score IS
    'Baseline 0-100 activation score per facility. Weights are placeholders; '
    'business should tune in collaboration with sales-ops. >=70 is the active-target threshold.';

-- v_ghl_export_active_targets: facilities above the 70-point activation cutoff,
-- bucketed into a pipeline stage for GHL/CRM export.
CREATE OR REPLACE VIEW v_ghl_export_active_targets AS
SELECT
    s.enrollment_id,
    s.organization_name,
    s.vertical,
    s.state,
    s.ccn,
    s.ccn_acronym,
    s.medintel_score,
    CASE
        WHEN s.medintel_score >= 90 THEN 'hot'
        WHEN s.medintel_score >= 80 THEN 'warm'
        WHEN s.medintel_score >= 70 THEN 'qualified'
        ELSE                              'nurture'
    END AS pipeline_stage,
    s.has_pe_reit,
    s.has_chain_owner,
    s.last_chow_date,
    s.has_aco_npi_overlap,
    s.psi11_above_avg
FROM v_medintel_facility_score s
WHERE s.medintel_score >= 70;

COMMENT ON VIEW v_ghl_export_active_targets IS
    'Facilities at/above the 70-point activation threshold, bucketed for CRM (GoHighLevel) export.';

-- =====================================================================
-- END SCHEMA
-- =====================================================================
