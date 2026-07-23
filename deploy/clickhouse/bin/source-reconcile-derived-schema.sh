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

derived_schema_script=${ECHO_ANALYTICS_DERIVED_SCHEMA_SCRIPT:-$SCRIPT_DIR/reconcile-derived-schema-remote.sh}
if [[ ! -r "$derived_schema_script" ]]; then
  derived_schema_script="$SCRIPT_DIR/reconcile-derived-schema.sh"
fi
require_file "$derived_schema_script"

timeout --foreground 120s \
  ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$analytics_ssh_target" \
    'sudo -n env ECHO_ANALYTICS_LIB=/opt/echo-analytics/bin/lib.sh bash -s' \
  <"$derived_schema_script"

log "Derived analytics schema reconciled on $analytics_ssh_target"
