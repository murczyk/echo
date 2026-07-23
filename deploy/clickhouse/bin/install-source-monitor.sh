#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=./lib.sh
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

sudo install -d -o root -g root -m 0755 /opt/echo-peerdb/bin
sudo install -d -o root -g root -m 0755 /opt/echo-peerdb/env
sudo install -d -o "$automation_user" -g "$automation_group" -m 0750 \
  /var/lib/echo-peerdb
sudo install -o root -g root -m 0644 "$SCRIPT_DIR/lib.sh" /opt/echo-peerdb/bin/lib.sh
sudo install -o root -g root -m 0755 "$SCRIPT_DIR/wal-status.sh" /opt/echo-peerdb/bin/wal-status.sh
sudo install -o root -g root -m 0755 \
  "$SCRIPT_DIR/source-reconcile-tables.sh" \
  /opt/echo-peerdb/bin/source-reconcile-tables.sh
sudo install -o root -g root -m 0755 \
  "$SCRIPT_DIR/source-reconcile-if-needed.sh" \
  /opt/echo-peerdb/bin/source-reconcile-if-needed.sh
sudo install -o root -g root -m 0755 \
  "$SCRIPT_DIR/source-reconcile-derived-schema.sh" \
  /opt/echo-peerdb/bin/source-reconcile-derived-schema.sh
sudo install -o root -g root -m 0755 \
  "$SCRIPT_DIR/reconcile-derived-schema.sh" \
  /opt/echo-peerdb/bin/reconcile-derived-schema-remote.sh
sudo install -o root -g root -m 0644 \
  "$BUNDLE_DIR/env/tables-exclude.txt" \
  /opt/echo-peerdb/env/tables-exclude.txt
for unit in "$BUNDLE_DIR"/source-systemd/*; do
  sudo install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
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
