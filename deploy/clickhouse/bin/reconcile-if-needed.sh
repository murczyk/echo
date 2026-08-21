#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

check_only=false
case ${1:-} in
  '')
    ;;
  --check)
    check_only=true
    ;;
  *)
    die "usage: $0 [--check]"
    ;;
esac

acquire_analytics_reconcile_lock
require_expected_control_release
desired_state_id=$(analytics_desired_state_id)
reconciled_state_id=
if [[ -r "$ANALYTICS_RECONCILE_STATE_FILE" ]]; then
  read -r reconciled_state_id <"$ANALYTICS_RECONCILE_STATE_FILE"
fi

if $check_only; then
  "$SCRIPT_DIR/reconcile-gateway-settings.sh" --check
  "$SCRIPT_DIR/reconcile-schema.sh" --check
  [[ "$reconciled_state_id" == "$desired_state_id" ]] \
    || die "derived analytics state is stale: expected $desired_state_id, reconciled ${reconciled_state_id:-missing}"
  state_max_age=${ANALYTICS_RECONCILE_STATE_MAX_AGE_SECONDS:-180}
  [[ "$state_max_age" =~ ^[1-9][0-9]*$ ]] \
    || die "ANALYTICS_RECONCILE_STATE_MAX_AGE_SECONDS must be a positive integer"
  state_age=$(($(date +%s) - $(stat -c %Y "$ANALYTICS_RECONCILE_STATE_FILE")))
  ((state_age <= state_max_age)) \
    || die "analytics reconciliation is stale: ${state_age}s old, maximum ${state_max_age}s"
  log "Analytics control release and schemas are current"
  exit 0
fi

"$SCRIPT_DIR/reconcile-gateway-settings.sh"
"$SCRIPT_DIR/reconcile-schema.sh"
if [[ "$reconciled_state_id" != "$desired_state_id" ]]; then
  "$SCRIPT_DIR/reconcile-derived-schema.sh"
fi
install -d -m 0755 "$ANALYTICS_RECONCILE_STATE_DIR"
temporary_file=$(mktemp "$ANALYTICS_RECONCILE_STATE_DIR/.state.XXXXXX")
printf '%s\n' "$desired_state_id" >"$temporary_file"
chmod 0644 "$temporary_file"
mv -f "$temporary_file" "$ANALYTICS_RECONCILE_STATE_FILE"
log "Analytics desired state is reconciled as $desired_state_id"
