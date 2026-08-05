#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

namespace=${1:?namespace is required}
source_key=${2:?public key path is required}
dangerously_acknowledge=${3:-}
SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC1091
source "$BUNDLE_DIR/config/host.env"

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "provision-key-host.sh must run as root"
[[ $(hostname) == "$EXPECTED_HOSTNAME" ]] || die "unexpected host"
[[ "$dangerously_acknowledge" == true ]] \
  || die "missing dangerous-operation acknowledgement"
dispatcher_user=$("$SCRIPT_DIR/dispatcher-identity.sh" "$namespace")
[[ "$source_key" =~ ^/tmp/echo-ai-agent-key\.[A-Za-z0-9]+$ && -f "$source_key" ]] \
  || die "unsafe public key path"
[[ $(wc -l <"$source_key") -eq 1 ]] || die "public key file must contain one line"
key_type=$(awk '{print $1}' "$source_key")
key_data=$(awk '{print $2}' "$source_key")
[[ "$key_type" == ssh-ed25519 && -n "$key_data" ]] || die "invalid Ed25519 public key"
ssh-keygen -lf "$source_key" >/dev/null || die "invalid public key"

shopt -s nullglob
for existing_key_file in /etc/echo-ai-agent/authorized_keys/*; do
  [[ $(basename "$existing_key_file") == "$dispatcher_user" ]] && continue
  existing_key_data=$(awk 'NR == 1 { print $3 }' "$existing_key_file")
  [[ "$existing_key_data" != "$key_data" ]] \
    || die "dispatcher public key is already assigned to another Echo server"
done

"$SCRIPT_DIR/reconcile-dispatcher-identity.sh" "$namespace" >/dev/null
destination="/etc/echo-ai-agent/authorized_keys/$dispatcher_user"
temporary="${destination}.new.$$"
printf 'restrict %s %s %s\n' "$key_type" "$key_data" "$namespace" >"$temporary"
chown root:"$DISPATCH_GROUP" "$temporary"
chmod 0640 "$temporary"
mv -f "$temporary" "$destination"
ssh-keygen -lf "$destination"
printf '[echo-ai-agent] dispatcher identity installed namespace=%s user=%s\n' \
  "$namespace" "$dispatcher_user"
