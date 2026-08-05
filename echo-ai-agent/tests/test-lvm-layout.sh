#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
FIXTURE="$SCRIPT_DIR/lvm-layout.json"

jq -e --arg pv /dev/sda2 --arg vg ai-agents \
  -f "$BUNDLE_DIR/config/lvm-pv-layout.jq" "$FIXTURE" >/dev/null
jq -e --arg vg ai-agents \
  -f "$BUNDLE_DIR/config/lvm-vg-layout.jq" "$FIXTURE" >/dev/null
jq -e --arg vg ai-agents --arg thinpool IncusThinPool \
  -f "$BUNDLE_DIR/config/lvm-thinpool-layout.jq" "$FIXTURE" >/dev/null

invalid_fixture=$(mktemp)
trap 'rm -f -- "$invalid_fixture"' EXIT
jq '.report[0].lv += [{
  "vg_name": "ai-agents",
  "lv_name": "unexpected",
  "segtype": "linear"
}]' "$FIXTURE" >"$invalid_fixture"
if jq -e --arg vg ai-agents --arg thinpool IncusThinPool \
  -f "$BUNDLE_DIR/config/lvm-thinpool-layout.jq" "$invalid_fixture" >/dev/null; then
  printf 'unexpected non-Incus logical volume was accepted\n' >&2
  exit 1
fi
