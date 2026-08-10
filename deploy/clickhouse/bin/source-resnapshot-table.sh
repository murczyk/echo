#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
SOURCE_LIB=${ECHO_PEERDB_LIB:-$SCRIPT_DIR/lib.sh}
# shellcheck disable=SC1090,SC1091
source "$SOURCE_LIB"

migration_impact_file=${ECHO_PEERDB_MIGRATION_IMPACT_FILE:-$BUNDLE_DIR/migration-impact.json}
analytics_resnapshot_script=${ECHO_ANALYTICS_RESNAPSHOT_SCRIPT:-$SCRIPT_DIR/resnapshot-table.sh}
remote_timeout=${ANALYTICS_TABLE_RESNAPSHOT_REMOTE_TIMEOUT_SECONDS:-7500}

validate_source_table() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
    || die "invalid source table: $1"
}

manifest_resnapshot_tables() {
  python3 - "$migration_impact_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
tables = {
    change["table"]
    for section in ("migrations", "dependencies")
    for declaration in manifest[section].values()
    for change in declaration["changes"]
    if change["strategy"] == "empty_table_resnapshot"
}
print(*sorted(tables), sep="\n")
PY
}

require_manifest_authorization() {
  local source_table=$1
  python3 - "$migration_impact_file" "$source_table" <<'PY' \
    || die "$source_table is not authorized for empty_table_resnapshot"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
authorized = any(
    change.get("table") == sys.argv[2]
    and change.get("strategy") == "empty_table_resnapshot"
    for section in ("migrations", "dependencies")
    for declaration in manifest[section].values()
    for change in declaration.get("changes", [])
)
raise SystemExit(0 if authorized else 1)
PY
}

run_remote_resnapshot() {
  local source_table=$1
  log "Checking targeted empty-table resnapshot for $source_table on $analytics_ssh_target"
  timeout --foreground "${remote_timeout}s" \
    ssh \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      "$analytics_ssh_target" \
      "sudo -n env ECHO_ANALYTICS_LIB=/opt/echo-analytics/bin/lib.sh bash -s -- $source_table" \
    <"$analytics_resnapshot_script"
}

main() {
  local mode=${1:-} source_table=${2:-}
  local -a source_tables=()

  case $mode in
    --table)
      [[ -n "$source_table" && $# -eq 2 ]] \
        || die "usage: $0 --table SCHEMA.TABLE|--manifest"
      validate_source_table "$source_table"
      source_tables+=("$source_table")
      ;;
    --manifest)
      [[ $# -eq 1 ]] || die "usage: $0 --table SCHEMA.TABLE|--manifest"
      ;;
    *)
      die "usage: $0 --table SCHEMA.TABLE|--manifest"
      ;;
  esac

  load_source_config
  require_cmd python3
  require_cmd ssh
  require_cmd timeout
  require_file "$migration_impact_file"
  require_file "$analytics_resnapshot_script"
  [[ "$remote_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "ANALYTICS_TABLE_RESNAPSHOT_REMOTE_TIMEOUT_SECONDS must be a positive integer"

  analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
  [[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
    || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"
  acquire_source_reconcile_lock

  if [[ "$mode" == --table ]]; then
    require_manifest_authorization "$source_table"
  else
    mapfile -t source_tables < <(manifest_resnapshot_tables)
  fi

  if ((${#source_tables[@]} == 0)); then
    log "No manifest-authorized empty-table resnapshots are configured"
    return 0
  fi
  for source_table in "${source_tables[@]}"; do
    validate_source_table "$source_table"
    run_remote_resnapshot "$source_table"
  done
}

main "$@"
