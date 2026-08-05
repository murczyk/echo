#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_ADMIN_HOST}
dangerously_acknowledge=${2:-}

require_cmd ssh
validate_bundle
require_dangerous_acknowledgement "$dangerously_acknowledge"
ssh_target admin "$target_host" \
  sudo -n /opt/echo-ai-agent/current/bin/rollback-host.sh \
  "$dangerously_acknowledge"
