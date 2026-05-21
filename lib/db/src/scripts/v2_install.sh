#!/usr/bin/env bash
# v2_install.sh — apply every v2.0 SQL companion script in order.
#
# Usage:
#   DATABASE_URL=postgres://... bash lib/db/src/scripts/v2_install.sh
#
# Idempotent — every contained script is safe to re-run. Stops at the
# first failure so operators see exactly which step needs attention.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL must be set." >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

scripts=(
  "v2_confidence_layer.sql"
  "v2_equipment_age.sql"
  "v2_opportunity_rls.sql"
  "v2b_con_documents.sql"
  "seed_freshness.sql"
  "v2a_chat_tables.sql"
  "v2a_chat_layer.sql"
  "v2a_seed_paid_sources.sql"
  "v2a_seed_sub_agents.sql"
  "v2c_mcp_cache.sql"
)

for s in "${scripts[@]}"; do
  echo "==> Applying $s"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/$s"
done

echo "==> Done — v2.0 SQL companions applied."
