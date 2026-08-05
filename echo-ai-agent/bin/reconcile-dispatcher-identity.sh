#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

namespace=${1:?Echo server namespace is required}
SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC1091
source "$BUNDLE_DIR/config/host.env"

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "reconcile-dispatcher-identity.sh must run as root"
dispatcher_user=$("$SCRIPT_DIR/dispatcher-identity.sh" "$namespace")
runtime_home="$DISPATCH_RUNTIME_ROOT/$dispatcher_user"
namespace_file="$DISPATCH_NAMESPACE_DIR/$dispatcher_user"

getent group "$DISPATCH_GROUP" >/dev/null || die "dispatcher group is missing"
getent group incus-admin >/dev/null || die "incus-admin group is missing"
install -d -o root -g root -m 0755 "$DISPATCH_NAMESPACE_DIR"

if [[ -e "$namespace_file" ]]; then
  [[ -f "$namespace_file" && ! -L "$namespace_file" ]] \
    || die "unsafe dispatcher namespace mapping: $namespace_file"
  [[ $(<"$namespace_file") == "$namespace" ]] \
    || die "dispatcher user is already mapped to another namespace"
elif id "$dispatcher_user" >/dev/null 2>&1; then
  [[ "$namespace" == echo-staging && "$dispatcher_user" == echo-ai-agent-staging ]] \
    || die "dispatcher user already exists without a managed namespace mapping"
fi

if ! id "$dispatcher_user" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "$DISPATCH_GROUP" \
    --groups incus-admin \
    --home-dir "$runtime_home" \
    --no-create-home \
    --shell /bin/sh \
    "$dispatcher_user"
fi

usermod \
  --append \
  --groups incus-admin \
  --gid "$DISPATCH_GROUP" \
  --home "$runtime_home" \
  --shell /bin/sh \
  "$dispatcher_user"

shadow_hash=$(getent shadow "$dispatcher_user" | cut -d: -f2)
if [[ ! "$shadow_hash" =~ ^\$6\$ ]]; then
  password_hash=$(openssl rand -base64 48 | openssl passwd -6 -stdin)
  [[ "$password_hash" =~ ^\$6\$ ]] || die "failed to generate dispatcher password hash"
  printf '%s:%s\n' "$dispatcher_user" "$password_hash" | chpasswd --encrypted
fi

mapping_tmp="${namespace_file}.new.$$"
printf '%s\n' "$namespace" >"$mapping_tmp"
chown root:root "$mapping_tmp"
chmod 0644 "$mapping_tmp"
mv -f "$mapping_tmp" "$namespace_file"
install -d -o "$dispatcher_user" -g "$DISPATCH_GROUP" -m 0700 "$runtime_home"
printf '%s\n' "$dispatcher_user"
