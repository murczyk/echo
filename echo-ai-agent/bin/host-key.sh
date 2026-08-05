#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_ADMIN_HOST}
dispatcher_host=${DISPATCH_HOST:-echo-ai-agent-vm}

require_cmd ssh
validate_bundle
key_line=$(ssh_target admin "$target_host" \
  sudo -n cat /etc/echo-ai-agent/ssh_host_ed25519_key.pub)
[[ "$key_line" != *$'\n'* ]] || die "target returned more than one host key"
read -r key_type key_data _ <<<"$key_line"
[[ -n "$key_type" && -n "$key_data" ]] || die "target returned an invalid host key"
key="$key_type $key_data"
[[ $key == ssh-ed25519\ * ]] || die "target returned an invalid host key"
printf '[%s]:%s %s\n' "$dispatcher_host" "$DISPATCH_PORT" "$key"
fingerprint=$(ssh_target admin "$target_host" \
  sudo -n ssh-keygen -lf /etc/echo-ai-agent/ssh_host_ed25519_key.pub)
printf '%s\n' "$fingerprint" >&2
