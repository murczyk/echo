#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
load_source_config
ensure_yes "${1:-}"

require_cmd sudo
require_cmd systemctl

automation_user=${ECHO_PEERDB_AUTOMATION_USER:-${SUDO_USER:-$(id -un)}}
[[ "$automation_user" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || die "invalid automation user: $automation_user"
id "$automation_user" >/dev/null 2>&1 \
  || die "automation user does not exist: $automation_user"
automation_group=$(id -gn "$automation_user")

SOURCE_RECONCILE_LOCK_WAIT_SECONDS=${SOURCE_RECONCILE_LOCK_WAIT_SECONDS:-300}
acquire_source_reconcile_lock
sudo install -d -o "$automation_user" -g "$automation_group" -m 0750 \
  /var/lib/echo-peerdb
control_release=$(control_bundle_release_id "$BUNDLE_DIR")
sudo "$SCRIPT_DIR/install-control-release.sh" source "$control_release"
sudo install -d -o root -g root -m 0755 /opt/echo-peerdb/bin
for shim in "$BUNDLE_DIR"/shims/*; do
  sudo install -o root -g root -m 0755 \
    "$shim" "/opt/echo-peerdb/bin/$(basename "$shim")"
done

unit_override=$(mktemp /tmp/echo-peerdb-table-reconcile-user.XXXXXX)
trap 'rm -f -- "$unit_override"' EXIT
printf '[Service]\nUser=%s\nGroup=%s\n' \
  "$automation_user" "$automation_group" >"$unit_override"
sudo install -d -o root -g root -m 0755 \
  /etc/systemd/system/echo-peerdb-table-reconcile.service.d
sudo install -o root -g root -m 0644 "$unit_override" \
  /etc/systemd/system/echo-peerdb-table-reconcile.service.d/user.conf

sudo systemctl daemon-reload
sudo systemctl enable --now \
  echo-peerdb-wal-monitor.timer \
  echo-peerdb-table-reconcile.timer
sudo systemctl start echo-peerdb-wal-monitor.service
log "Installed source WAL monitoring and automatic table reconciliation for $automation_user"
