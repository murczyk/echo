#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

builder=${1:-$ANALYTICS_BUILDER_SSH}
remote_dir=${2:-/srv/echo-clickhouse-build/$PEERDB_VERSION/artifacts}
local_dir=${3:-$BUNDLE_DIR/build/artifacts}

require_cmd rsync
mkdir -p "$local_dir"
rsync -av --delete-delay "$builder:$remote_dir/" "$local_dir/"
(
  cd "$local_dir"
  sha256sum --check SHA256SUMS
)

log "Verified artifacts in $local_dir"
