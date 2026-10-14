#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
ensure_yes "${1:-}"
delegate_paired_analytics_operation_if_source \
  oneoff-replicate-attachment-history.sh --yes
load_analytics_config
validate_runtime_identifiers
acquire_analytics_reconcile_lock
require_expected_control_release

ensure_attachment_search_coverage_table
postgres_psql --dbname "$GATEWAY_DB" -q -v ON_ERROR_STOP=1 <<'SQL'
UPDATE public.echo_analytics_attachment_search SET history_complete=false WHERE singleton;
SQL

for table in public.attachment_document public.attachment_chunk; do
  log "Copying historical rows for $table"
  "$SCRIPT_DIR/resnapshot-table.sh" --strategy replicated_snapshot "$table" --force
done

"$SCRIPT_DIR/check-analytics-health.sh"
started_at=$(source_psql -Atq -v ON_ERROR_STOP=1 \
  -c "SELECT now() AT TIME ZONE 'UTC'")
postgres_psql --dbname "$GATEWAY_DB" -q -v ON_ERROR_STOP=1 \
  -v started_at="$started_at" <<'SQL'
INSERT INTO public.echo_analytics_attachment_search (singleton, started_at, history_complete)
VALUES (true, :'started_at', true)
ON CONFLICT (singleton) DO UPDATE SET history_complete=true;
SQL
log "Historical attachment documents and chunks are replicated; analytics search coverage is complete"
