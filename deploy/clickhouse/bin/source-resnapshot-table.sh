#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
SOURCE_LIB=${ECHO_PEERDB_LIB:-$SCRIPT_DIR/lib.sh}
# shellcheck disable=SC1090,SC1091
source "$SOURCE_LIB"

migration_impact_file=${ECHO_PEERDB_MIGRATION_IMPACT_FILE:-$BUNDLE_DIR/migration-impact.json}
remote_timeout=${ANALYTICS_TABLE_RESNAPSHOT_REMOTE_TIMEOUT_SECONDS:-7500}

validate_source_table() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
    || die "invalid source table: $1"
}

manifest_resnapshot_entries() {
  python3 - \
    "$migration_impact_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
entries = {
    (change["table"], change["strategy"])
    for section in ("migrations", "dependencies")
    for key, declaration in manifest[section].items()
    for change in declaration["changes"]
    if change["strategy"] in {"empty_table_resnapshot", "cdc_additive"}
    or (
        change["strategy"] == "replicated_snapshot"
        and change.get("targeted_resnapshot") is True
    )
}
strategies_by_table = {}
for table, strategy in entries:
    strategies_by_table.setdefault(table, set()).add(strategy)
conflicts = {
    table: strategies
    for table, strategies in strategies_by_table.items()
    if len(strategies) != 1
}
if conflicts:
    raise SystemExit(f"conflicting resnapshot strategies: {conflicts}")
for table in sorted(strategies_by_table):
    print(next(iter(strategies_by_table[table])), table, sep="\t")
PY
}

manifest_resnapshot_strategy() {
  local source_table=$1
  python3 - "$migration_impact_file" "$source_table" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
strategies = {
    change.get("strategy")
    for section in ("migrations", "dependencies")
    for declaration in manifest[section].values()
    for change in declaration.get("changes", [])
    if change.get("table") == sys.argv[2]
    and (
        change.get("strategy") in {"empty_table_resnapshot", "cdc_additive"}
        or (
            change.get("strategy") == "replicated_snapshot"
            and change.get("targeted_resnapshot") is True
        )
    )
}
if len(strategies) != 1:
    raise SystemExit(1)
print(next(iter(strategies)))
PY
}

run_remote_resnapshot() {
  local strategy=$1 source_table=$2
  local cdc_timeout=${ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}
  [[ "$cdc_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS must be a positive integer"
  log "Checking targeted $strategy repair for $source_table on $analytics_ssh_target"
  timeout --foreground "${remote_timeout}s" \
    ssh \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      "$analytics_ssh_target" \
      "sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$control_release ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS=$cdc_timeout /opt/echo-analytics/current/bin/resnapshot-table.sh --strategy $strategy $source_table"
}

run_remote_batch() {
  local cdc_timeout=${ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}
  [[ "$cdc_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS must be a positive integer"
  timeout --foreground "${remote_timeout}s" \
    ssh -o BatchMode=yes -o ConnectTimeout=10 \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      "$analytics_ssh_target" \
      "sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$control_release ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS=$cdc_timeout /opt/echo-analytics/current/bin/resnapshot-table.sh --batch"
}

main() {
  local mode=${1:-} source_table=${2:-} strategy entries
  local -a source_tables=()
  declare -A strategies_by_table=()

  case $mode in
    --table)
      [[ -n "$source_table" && $# -eq 2 ]] \
        || die "usage: $0 --table SCHEMA.TABLE|--manifest"
      validate_source_table "$source_table"
      source_tables+=("$source_table")
      strategy=$(manifest_resnapshot_strategy "$source_table") \
        || die "$source_table is not authorized for a targeted table resnapshot"
      strategies_by_table["$source_table"]=$strategy
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
  [[ "$remote_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "ANALYTICS_TABLE_RESNAPSHOT_REMOTE_TIMEOUT_SECONDS must be a positive integer"

  analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
  [[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
    || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"
  control_release=$(require_paired_control_release "$analytics_ssh_target")
  acquire_source_reconcile_lock

  if [[ "$mode" == --manifest ]]; then
    entries=$(manifest_resnapshot_entries)
    run_remote_batch <<<"$entries"
    return 0
  fi

  if ((${#source_tables[@]} == 0)); then
    log "No deployment-scoped targeted table resnapshots are configured"
    return 0
  fi
  for source_table in "${source_tables[@]}"; do
    validate_source_table "$source_table"
    strategy=${strategies_by_table["$source_table"]}
    run_remote_resnapshot "$strategy" "$source_table"
  done
}

if [[ ${ECHO_SOURCE_RESNAPSHOT_TEST_MODE:-false} != true ]]; then
  main "$@"
fi
