#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_ADMIN_HOST}
connection_mode=${2:-admin}

require_cmd jq
require_cmd ssh
validate_bundle
ssh_target "$connection_mode" "$target_host" bash -s -- \
  "$EXPECTED_HOSTNAME" \
  "$EXPECTED_OS_ID" \
  "$EXPECTED_OS_VERSION_ID" \
  "$EXPECTED_ARCH" \
  "$EXPECTED_PARTITION_TABLE" \
  "$STORAGE_DISK" \
  "$STORAGE_PARTITION" \
  "$STORAGE_MARKER" \
  "$STORAGE_ROOT_PARTITION" \
  "$STORAGE_LOGICAL_SECTOR_BYTES" \
  "$STORAGE_ROOT_START_SECTOR" \
  "$STORAGE_ROOT_SECTORS" \
  "$STORAGE_ROOT_FSTYPE" \
  "$STORAGE_ROOT_MOUNTPOINT" \
  "$STORAGE_MIN_FREE_BYTES" \
  "$DISPATCH_PORT" \
  "$STORAGE_POOL" \
  "$STORAGE_VG" \
  "$STORAGE_THINPOOL" \
  <"$BUNDLE_DIR/bin/preflight-remote.sh"
