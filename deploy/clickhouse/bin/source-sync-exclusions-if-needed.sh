#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

protected_file_exists "$SOURCE_CONFIG_FILE" || exit 0
load_source_config
ensure_yes "${1:-}"

require_cmd diff
require_cmd sudo
require_file "$SOURCE_TABLE_EXCLUDE_REPO_FILE"

if protected_file_exists "$SOURCE_TABLE_EXCLUDE_FILE" \
  && source_exclusions_match \
    "$SOURCE_TABLE_EXCLUDE_FILE" \
    "$SOURCE_TABLE_EXCLUDE_REPO_FILE"
then
  sudo install -o root -g root -m 0600 \
    "$SOURCE_TABLE_EXCLUDE_REPO_FILE" "$SOURCE_TABLE_EXCLUDE_FILE"
  log "Packaged and deployed table exclusions select the same tables"
  exit 0
fi

log "Packaged table exclusions changed; reconciling before migrations"
exec "$SCRIPT_DIR/source-sync-exclusions.sh" --yes
