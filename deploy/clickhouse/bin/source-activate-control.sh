#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

ensure_yes "${1:-}"
protected_file_exists "$SOURCE_CONFIG_FILE" || exit 0
load_source_config
require_cmd ssh
require_cmd sudo
require_cmd tar

SOURCE_RECONCILE_LOCK_WAIT_SECONDS=${SOURCE_RECONCILE_LOCK_WAIT_SECONDS:-300}
acquire_source_reconcile_lock
sudo systemctl stop echo-peerdb-table-reconcile.timer >/dev/null 2>&1 || true
restart_source_timer=true
trap 'if $restart_source_timer; then sudo systemctl enable --now echo-peerdb-table-reconcile.timer >/dev/null 2>&1 || true; fi' EXIT

release_id=$(control_bundle_release_id "$BUNDLE_DIR")
analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
[[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
  || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"

log "Staging analytics control release $release_id on $analytics_ssh_target"
archive_control_bundle "$BUNDLE_DIR" \
  | ssh \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      "$analytics_ssh_target" \
      "set -euo pipefail
       temporary_dir=\$(mktemp -d /tmp/echo-analytics-control.XXXXXX)
       trap 'rm -rf -- \"\$temporary_dir\"' EXIT
       tar -C \"\$temporary_dir\" -xf -
       sudo \"\$temporary_dir/bin/install-control-release.sh\" analytics '$release_id'"

sudo "$SCRIPT_DIR/install-control-release.sh" source "$release_id"

remote_release=$(ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  "$analytics_ssh_target" \
  'cat /opt/echo-analytics/current/release-id')
[[ "$remote_release" == "$release_id" ]] \
  || die "paired analytics control release mismatch: expected $release_id, active $remote_release"

restart_source_timer=false
sudo systemctl enable --now echo-peerdb-table-reconcile.timer >/dev/null
trap - EXIT
log "Source and analytics hosts use control release $release_id"
