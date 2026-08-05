#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_ADMIN_HOST}
public_key=${2:?public key path is required}
echo_server=${3:?Echo server is required}
dangerously_acknowledge=${4:-}
remote_key=

cleanup() {
  if [[ -n "$remote_key" && "$remote_key" =~ ^/tmp/echo-ai-agent-key\.[A-Za-z0-9]+$ ]]; then
    ssh_target admin "$target_host" rm -f -- "$remote_key" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_cmd scp
require_cmd ssh
require_cmd ssh-keygen
validate_bundle
require_dangerous_acknowledgement "$dangerously_acknowledge"
"$SCRIPT_DIR/dispatcher-identity.sh" "$echo_server" >/dev/null
[[ -f "$public_key" ]] || die "public key does not exist: $public_key"
[[ $(awk 'NR == 1 { print $1 }' "$public_key") == ssh-ed25519 ]] \
  || die "only an Ed25519 public key is accepted"
[[ $(wc -l <"$public_key") -eq 1 ]] || die "public key file must contain exactly one key"
ssh-keygen -lf "$public_key" >/dev/null || die "invalid public key"

remote_key=$(ssh_target admin "$target_host" \
  mktemp /tmp/echo-ai-agent-key.XXXXXX)
[[ "$remote_key" =~ ^/tmp/echo-ai-agent-key\.[A-Za-z0-9]+$ ]] \
  || die "target returned an unsafe key path"
scp_to_target admin "$public_key" "$target_host" "$remote_key"
ssh_target admin "$target_host" \
  sudo -n /opt/echo-ai-agent/current/bin/provision-key-host.sh \
  "$echo_server" "$remote_key" "$dangerously_acknowledge"
