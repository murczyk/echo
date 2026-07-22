#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_source_config
ensure_yes "${1:-}"

require_cmd sudo
require_file "$SOURCE_TABLE_EXCLUDE_REPO_FILE"
sudo install -d -o root -g root -m 0755 \
  "$(dirname "$SOURCE_TABLE_EXCLUDE_FILE")"
sudo install -o root -g root -m 0600 \
  "$SOURCE_TABLE_EXCLUDE_REPO_FILE" "$SOURCE_TABLE_EXCLUDE_FILE"
log "Deployed repository table exclusions to $SOURCE_TABLE_EXCLUDE_FILE"

exec "$SCRIPT_DIR/source-reconcile-tables.sh" --yes
