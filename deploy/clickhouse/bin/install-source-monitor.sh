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

sudo install -d -o root -g root -m 0755 /opt/echo-peerdb/bin
sudo install -o root -g root -m 0644 "$SCRIPT_DIR/lib.sh" /opt/echo-peerdb/bin/lib.sh
sudo install -o root -g root -m 0755 "$SCRIPT_DIR/wal-status.sh" /opt/echo-peerdb/bin/wal-status.sh
for unit in "$BUNDLE_DIR"/source-systemd/*; do
  sudo install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done

sudo systemctl daemon-reload
sudo systemctl enable --now echo-peerdb-wal-monitor.timer
sudo systemctl start echo-peerdb-wal-monitor.service
log "Installed the source WAL monitor timer"
