#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_source_config
ensure_source_publication_generated_columns

require_cmd ssh
require_cmd timeout

analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
[[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
  || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"
control_release=$(require_paired_control_release "$analytics_ssh_target")

timeout --foreground 120s \
  ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$analytics_ssh_target" \
    "ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$control_release /opt/echo-analytics/current/bin/reconcile-derived-schema.sh"

log "Derived analytics schema reconciled on $analytics_ssh_target"
