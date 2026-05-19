# medintel_os — CMS warehouse ETL

Standalone PostgreSQL warehouse for CMS provider data (PECOS, HCRIS, ACO, ASM, CMMI, DME, PSI-11). Independent from the app's Drizzle-managed schema in `lib/db/`.

## Files

- `medintel_os_schema.sql` — schema, functions (`norm_flag`, `safe_num`, `derive_ccn_acronym`), `ref_ccn_acronym` ranges, all dim/bridge/fact tables, and the `v_chain_ownership` / `v_medintel_facility_score` / `v_ghl_export_active_targets` views. Idempotent.
- `medintel_os_load.sql` — staging DDL + `\copy` loads + INSERT…SELECT transforms for the 21 CSVs in the April–May 2026 drop. Idempotent (TRUNCATE staging, ON CONFLICT on production).
- `MEDINTEL_OS_DATA_ROUTING.md` — file-by-file routing reference and the scoring-model placeholder.

## Run

```bash
createdb medintel
psql -d medintel <<'EOF'
\set data_path '/abs/path/to/cms/files'
\i medintel_os/medintel_os_schema.sql
\i medintel_os/medintel_os_load.sql
EOF
```

`data_path` is the directory holding the 21 CSVs. The load script builds each absolute filename with `\set csvfile :data_path '/...csv'` before every `\copy` (the natural `:'data_path/foo.csv'` form does not interpolate in psql).

## Notes

- The Hospital Enrollments file was not in the drop. Its `\copy` block is left commented in `B.1`. Until it loads, Hospital All_Owners rows insert into `dim_owner` but their `fact_ownership` rows are skipped (the `EXISTS dim_facility` guard), and Hospital_CHOW_NPIs / SNF_CHOW_NPIs sit orphan in `stage_pecos_addl_npis`.
- The Hospital Service Area staging schema is provisional. Inspect the CSV header (`head -1 Hospital_Service_Area_2024.csv`) and adjust `stage_service_area` columns before running.
- The 70-point activation threshold and per-signal weights in `v_medintel_facility_score` are placeholders. Tune against real conversion data before relying on the GHL export.
