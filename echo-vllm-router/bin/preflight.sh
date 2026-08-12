#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_TARGET_HOST}

require_cmd awk
require_cmd sha256sum
require_cmd ssh
validate_bundle
run_remote_preflight "$target_host"
