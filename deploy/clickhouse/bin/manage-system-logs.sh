#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=./clickhouse-system-log-policy.sh
source "$SCRIPT_DIR/clickhouse-system-log-policy.sh"

usage() {
  printf 'usage: %s --check | --apply --truncate --yes\n' "$0" >&2
}

mode='' check=false apply=false truncate=false confirmed=false
for argument in "$@"; do
  case $argument in
    --check)
      $check && die "--check was specified more than once"
      check=true
      ;;
    --apply)
      $apply && die "--apply was specified more than once"
      apply=true
      ;;
    --truncate)
      $truncate && die "--truncate was specified more than once"
      truncate=true
      ;;
    --yes)
      $confirmed && die "--yes was specified more than once"
      confirmed=true
      ;;
    *)
      usage
      die "unknown argument: $argument"
      ;;
  esac
done

if $check && ! $apply && ! $truncate && ! $confirmed; then
  mode=check
elif ! $check && $apply && $truncate && $confirmed; then
  mode=apply
else
  usage
  die "mutating mode requires all of --apply --truncate --yes"
fi

source_env_file "$INSTANCE_FILE"
source_env_file "$CLICKHOUSE_SECRETS_FILE"
require_secret CLICKHOUSE_ADMIN_PASSWORD
require_cmd clickhouse-client
require_cmd clickhouse

clickhouse_admin --query 'SELECT 1' >/dev/null \
  || die "authenticated ClickHouse health check failed"
if [[ "$mode" == check ]]; then
  report_clickhouse_system_log_policy
  verify_clickhouse_system_log_policy
  log "ClickHouse system-log policy is healthy"
  exit 0
fi

for command in cmp install mktemp sudo systemctl; do
  require_cmd "$command"
done

validate_rendered_clickhouse_system_log_config
# A prepared system-log table is renamed on restart when its CREATE definition
# differs from the configured one. Flush first, then align the live TTLs so the
# restart keeps the four existing table identities.
clickhouse_admin --query 'SYSTEM FLUSH LOGS'
log "Aligning existing ClickHouse diagnostic-table TTLs"
apply_clickhouse_system_log_ttls
log "Installing the bounded ClickHouse system-log policy"
install_clickhouse_system_log_config
sudo systemctl restart clickhouse-server
wait_for_authenticated_clickhouse
verify_clickhouse_system_log_policy

log "Synchronously truncating the four managed ClickHouse diagnostic tables"
truncate_clickhouse_system_logs
report_clickhouse_system_log_policy
verify_clickhouse_system_log_policy
log "ClickHouse system-log maintenance completed"
