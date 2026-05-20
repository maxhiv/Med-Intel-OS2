#!/usr/bin/env bash
# medintel_os/prepare_data_dir.sh
#
# Symlinks attached_assets/<Name>_<timestamp>.csv → medintel_data/<Name>.csv
# so the medintel_os_load.sql script (which expects clean names) finds them.
#
# Usage:
#   bash medintel_os/prepare_data_dir.sh                  # default dirs
#   bash medintel_os/prepare_data_dir.sh /path/to/source /path/to/dest
#
# After this runs, load the warehouse with:
#   psql "$DATABASE_URL" -v data_path="$(pwd)/medintel_data" \
#     -f medintel_os/medintel_os_load.sql

set -euo pipefail

SRC="${1:-attached_assets}"
DEST="${2:-medintel_data}"

if [ ! -d "$SRC" ]; then
  echo "ERROR: source directory '$SRC' not found." >&2
  exit 1
fi

mkdir -p "$DEST"
SRC_ABS="$(cd "$SRC" && pwd)"
DEST_ABS="$(cd "$DEST" && pwd)"

# Map: <expected clean filename in load script> → <prefix to match in attached_assets>.
# When multiple attached files share a prefix, the longest match wins via
# `ls -1 ... | sort -r | head -1`. Anything not matched is reported at the end.
declare -A MAP=(
  ["FQHC_Enrollments_2026.04.01.csv"]="FQHC_Enrollments_2026.04.01"
  ["RHC_Enrollments_2026.04.01.csv"]="RHC_Enrollments_2026.04.01"
  ["Hospital_Enrollments_2026.05.01.csv"]="Hospital_Enrollments_2026.05.01"
  ["FQHC_All_Owners_2026.04.01.csv"]="FQHC_All_Owners_2026.04.01"
  ["RHC_All_Owners_2026.04.01.csv"]="RHC_All_Owners_2026.04.01"
  ["Hospital_All_Owners_2026.05.01.csv"]="Hospital_All_Owners_2026.05.01"
  ["FQHC_Additional_NPIs_2026.04.01.csv"]="FQHC_Additional_NPIs_2026.04.01"
  ["RHC_Additional_NPIs_2026.04.01.csv"]="RHC_Additional_NPIs_2026.04.01"
  ["Hospital_CHOW_NPIs_2026.04.01.csv"]="Hospital_CHOW_NPIs_2026.04.01"
  ["SNF_CHOW_NPIs_2026.04.01.csv"]="SNF_CHOW_NPIs_2026.04.01"
  ["FQHC_Additional_Addresses_2026.04.01.csv"]="FQHC_Additional_Addresses_2026.04.01"
  ["RHC_Additional_Addresses_2026.04.01.csv"]="RHC_Additional_Addresses_2026.04.01"
  ["Hospital_CHOW_2026.04.01.csv"]="Hospital_CHOW_2026.04.01"
  ["CostReport_2023_Final.csv"]="CostReport_2023_Final"
  ["Hospital_Service_Area_2024.csv"]="Hospital_Service_Area_2024"
  ["ProviderLevel_Measure_Rates_for_AHRQ_Patient_Safety_Indicator_11__PSI11____2016.csv"]="Provider"
  ["mup_dme_ry25_p05_v10_dy23_geor.csv"]="mup_dme_ry25_p05_v10_dy23_geor"
  ["Advance_Investment_Payment_Spend_Plan_2026.csv"]="Advance_Investment_Payment_Spend_Plan_2026"
  ["CY27_Prelim_ASMParticipants_Public.csv"]="CY27_Prelim_ASMParticipants"
  ["WDDSEModelSummaryGUIDE051926.csv"]="WDDSE"
  ["PY_2024_ACO_Results_PUF_Rerun_20250925.csv"]="PY_2024_ACO_Results_PUF"
)

linked=0
missing=()
for target in "${!MAP[@]}"; do
  prefix="${MAP[$target]}"
  match=$(find "$SRC_ABS" -maxdepth 1 -type f -iname "${prefix}*.csv" | sort -r | head -1 || true)
  if [ -z "$match" ]; then
    missing+=("$target  (looked for: ${prefix}*.csv)")
    continue
  fi
  ln -sf "$match" "$DEST_ABS/$target"
  linked=$((linked + 1))
done

echo
echo "==> Linked $linked CSV file(s) into $DEST_ABS"
ls -la "$DEST_ABS/" | head -25
echo

if [ ${#missing[@]} -gt 0 ]; then
  echo "==> WARNING: ${#missing[@]} file(s) not found in $SRC_ABS:"
  for m in "${missing[@]}"; do echo "    - $m"; done
  echo "    The load script will skip these — corresponding fact/dim tables will be empty."
fi

echo
echo "Next:"
echo "  psql \"\$DATABASE_URL\" -v data_path=\"$DEST_ABS\" -f medintel_os/medintel_os_load.sql"
