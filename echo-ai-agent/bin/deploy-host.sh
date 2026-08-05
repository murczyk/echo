#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_ADMIN_HOST}
dangerously_acknowledge=${2:-}
remote_root=

cleanup() {
  [[ -z "$remote_root" ]] || remove_remote_stage "$target_host" "$remote_root"
}
trap cleanup EXIT

require_cmd jq
require_cmd ssh
require_cmd tar
validate_bundle
require_dangerous_acknowledgement "$dangerously_acknowledge"
"$SCRIPT_DIR/preflight.sh" "$target_host"
remote_root=$(make_remote_stage "$target_host")
ssh_target admin "$target_host" \
  sudo -n "$remote_root/bin/install-host.sh" "$remote_root" \
  "$dangerously_acknowledge"
"$SCRIPT_DIR/verify.sh" "$target_host"
