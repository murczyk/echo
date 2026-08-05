#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC1091
source "$BUNDLE_DIR/config/host.env"

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "prepare-dispatcher-homes.sh must run as root"
install -d -o root -g "$DISPATCH_GROUP" -m 0750 "$DISPATCH_RUNTIME_ROOT"
if [[ -e "$DISPATCH_LOCK_PATH" || -L "$DISPATCH_LOCK_PATH" ]]; then
  [[ -f "$DISPATCH_LOCK_PATH" && ! -L "$DISPATCH_LOCK_PATH" ]] \
    || die "unsafe dispatcher lock file: $DISPATCH_LOCK_PATH"
else
  install -o root -g "$DISPATCH_GROUP" -m 0660 /dev/null "$DISPATCH_LOCK_PATH"
fi
chown root:"$DISPATCH_GROUP" "$DISPATCH_LOCK_PATH"
chmod 0660 "$DISPATCH_LOCK_PATH"

shopt -s nullglob
for namespace_file in "$DISPATCH_NAMESPACE_DIR"/*; do
  [[ -f "$namespace_file" && ! -L "$namespace_file" ]] \
    || die "unsafe dispatcher namespace mapping: $namespace_file"
  dispatcher_user=$(basename "$namespace_file")
  namespace=$(<"$namespace_file")
  expected_user=$("$SCRIPT_DIR/dispatcher-identity.sh" "$namespace")
  [[ "$dispatcher_user" == "$expected_user" ]] \
    || die "dispatcher namespace mapping has an unexpected user"
  account=$(getent passwd "$dispatcher_user")
  [[ -n "$account" ]] || die "dispatcher account is missing: $dispatcher_user"
  [[ $(cut -d: -f6 <<<"$account") == "$DISPATCH_RUNTIME_ROOT/$dispatcher_user" ]] \
    || die "dispatcher account has an unexpected home: $dispatcher_user"
  [[ $(id -gn "$dispatcher_user") == "$DISPATCH_GROUP" ]] \
    || die "dispatcher account has an unexpected primary group: $dispatcher_user"
  id -nG "$dispatcher_user" | tr ' ' '\n' | grep -Fqx incus-admin \
    || die "dispatcher account is not in incus-admin: $dispatcher_user"

  runtime_home="$DISPATCH_RUNTIME_ROOT/$dispatcher_user"
  if [[ -e "$runtime_home" ]]; then
    [[ -d "$runtime_home" && ! -L "$runtime_home" ]] \
      || die "unsafe dispatcher runtime home: $runtime_home"
    find "$runtime_home" -mindepth 1 -depth -delete
  fi
  install -d -o "$dispatcher_user" -g "$DISPATCH_GROUP" -m 0700 "$runtime_home"
done
