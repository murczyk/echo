#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_ADMIN_HOST}

require_cmd jq
require_cmd ssh
validate_bundle
ssh_target admin "$target_host" bash -s -- \
  "$EXPECTED_HOSTNAME" \
  "$INCUS_DEBIAN_VERSION" \
  "$STORAGE_POOL" \
  "$STORAGE_PARTITION" \
  "$STORAGE_VG" \
  "$STORAGE_THINPOOL" \
  "$AGENT_BRIDGE" \
  "$AGENT_BRIDGE_IPV4" \
  "$AGENT_PROFILE" \
  "$AGENT_CPU_LIMIT" \
  "$AGENT_MEMORY_LIMIT" \
  "$AGENT_PROCESS_LIMIT" \
  "$AGENT_ROOT_SIZE" \
  "$AGENT_TEMPLATE" \
  "$NODE_VERSION" \
  "$PI_VERSION" \
  "$DISPATCH_PORT" \
  "$AGENT_MAX_RUNNING" \
  "$HARNESS_RELEASE" \
  "$AGENT_CONTAINER_UID" \
  "$AGENT_CONTAINER_GID" \
  "$DISPATCH_GROUP" \
  "$DISPATCH_NAMESPACE_DIR" \
  "$DISPATCH_RUNTIME_ROOT" \
  "$DISPATCH_LOCK_PATH" \
  <"$BUNDLE_DIR/bin/verify-remote.sh"
