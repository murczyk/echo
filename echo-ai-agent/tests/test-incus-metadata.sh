#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
FILTER="$BUNDLE_DIR/config/incus-instance-key.jq"
FIXTURE="$SCRIPT_DIR/incus-configuration-metadata.json"

jq -e --arg key security.guestapi -f "$FILTER" "$FIXTURE" >/dev/null
jq -e --arg key security.guestapi.images -f "$FILTER" "$FIXTURE" >/dev/null
if jq -e --arg key security.devlxd -f "$FILTER" "$FIXTURE" >/dev/null; then
  printf 'obsolete security.devlxd unexpectedly accepted\n' >&2
  exit 1
fi
for key in security.ipv4_filtering security.mac_filtering security.port_isolation; do
  jq -e --arg key "$key" -f "$BUNDLE_DIR/config/incus-nic-key.jq" \
    "$FIXTURE" >/dev/null
done
