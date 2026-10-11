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
deployment_lock=/run/lock/echo-ai-agent-deploy.lock
if [[ -e "$deployment_lock" || -L "$deployment_lock" ]]; then
  [[ -f "$deployment_lock" && ! -L "$deployment_lock" ]] \
    || die "unsafe deployment lock file: $deployment_lock"
else
  install -o root -g root -m 0644 /dev/null "$deployment_lock"
fi
chown root:root "$deployment_lock"
chmod 0644 "$deployment_lock"
install -d -o root -g "$DISPATCH_GROUP" -m 0750 "$DISPATCH_RUNTIME_ROOT"
if [[ -e "$DISPATCH_LOCK_PATH" || -L "$DISPATCH_LOCK_PATH" ]]; then
  [[ -f "$DISPATCH_LOCK_PATH" && ! -L "$DISPATCH_LOCK_PATH" ]] \
    || die "unsafe dispatcher lock file: $DISPATCH_LOCK_PATH"
else
  install -o root -g "$DISPATCH_GROUP" -m 0660 /dev/null "$DISPATCH_LOCK_PATH"
fi
chown root:"$DISPATCH_GROUP" "$DISPATCH_LOCK_PATH"
chmod 0660 "$DISPATCH_LOCK_PATH"
install -d -o root -g root -m 0755 /run/lock/echo-ai-agent-rollout
install -d -o root -g root -m 0755 /etc/echo-ai-agent/namespace-releases

shopt -s nullglob
for namespace_file in "$DISPATCH_NAMESPACE_DIR"/*; do
  [[ -f "$namespace_file" && ! -L "$namespace_file" ]] \
    || die "unsafe dispatcher namespace mapping: $namespace_file"
  dispatcher_user=$(basename "$namespace_file")
  namespace=$(<"$namespace_file")
  expected_user=$("$SCRIPT_DIR/dispatcher-identity.sh" "$namespace")
  rollout_lock="/run/lock/echo-ai-agent-rollout/$namespace.lock"
  if [[ ! -e "$rollout_lock" ]]; then
    install -o root -g root -m 0644 /dev/null "$rollout_lock"
  fi
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
    find "$runtime_home" -mindepth 1 -depth \
      ! \( -type f -name 'echo-ai-agent-*.lock' \) -delete
  fi
  install -d -o "$dispatcher_user" -g "$DISPATCH_GROUP" -m 0700 "$runtime_home"
done
