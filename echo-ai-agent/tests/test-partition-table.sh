#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

record=$(jq -r --arg storage /dev/sda2 \
  -f "$BUNDLE_DIR/config/storage-partition-record.jq" \
  "$SCRIPT_DIR/partition-table.json")
[[ "$record" == $'124999680\t1057794048\t8e' ]]
