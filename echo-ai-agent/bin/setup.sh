#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_BOOTSTRAP_HOST}
dangerously_acknowledge=${2:-}
connection_mode='bootstrap'
remote_root=

cleanup() {
  [[ -z "$remote_root" ]] || cleanup_remote_stage
}
trap cleanup EXIT

cleanup_remote_stage() {
  [[ "$remote_root" =~ ^/tmp/echo-ai-agent-deploy\.[A-Za-z0-9]+$ ]] || return 0
  ssh_target admin "$DEFAULT_ADMIN_HOST" \
    rm -rf -- "$remote_root" >/dev/null 2>&1 \
    || ssh_target "$connection_mode" "$target_host" \
      rm -rf -- "$remote_root" >/dev/null 2>&1 \
    || true
}

require_cmd jq
require_cmd ssh
require_cmd tar
validate_bundle
require_dangerous_acknowledgement "$dangerously_acknowledge"
if ! ssh_target bootstrap "$target_host" true >/dev/null 2>&1; then
  log "bootstrap SSH is unavailable; resuming through the pinned port-22 host key"
  target_host=$DEFAULT_ADMIN_HOST
  connection_mode='admin'
  ssh_target admin "$target_host" true >/dev/null \
    || die "neither bootstrap nor migrated admin SSH is reachable"
fi
"$SCRIPT_DIR/preflight.sh" "$target_host" "$connection_mode"
remote_root=$(make_remote_stage "$target_host" "$connection_mode")
ssh_target "$connection_mode" "$target_host" \
  sudo -n "$remote_root/bin/setup-host.sh" "$remote_root" \
  "$dangerously_acknowledge"
cleanup_remote_stage
remote_root=
