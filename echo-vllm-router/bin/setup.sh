#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_TARGET_HOST}

require_cmd ssh
validate_bundle
ssh -o BatchMode=yes "$target_host" bash -s -- \
  "$EXPECTED_HOSTNAME" \
  "$ROUTER_HOST" <<'REMOTE'
set -euo pipefail

expected_hostname=$1
expected_tailscale_ip=$2

[[ $(hostname) == "$expected_hostname" ]] || {
  printf 'expected hostname %s, found %s\n' "$expected_hostname" "$(hostname)" >&2
  exit 1
}
[[ $(dpkg --print-architecture) == amd64 ]] || {
  printf 'only amd64 is supported\n' >&2
  exit 1
}
# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] || {
  printf 'expected Debian 13, found %s %s\n' "$ID" "$VERSION_ID" >&2
  exit 1
}
[[ $(tailscale ip -4 | head -n 1) == "$expected_tailscale_ip" ]] || {
  printf 'unexpected Tailscale IP\n' >&2
  exit 1
}
sudo -n true
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --yes python3-venv
dpkg-query -W -f='${db:Status-Status}\n' python3-venv | grep -Fx installed >/dev/null
printf '[echo-vllm-router] Target prerequisites are installed\n'
REMOTE
