#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC1091
source "$BUNDLE_DIR/config/host.env"

[[ -z ${SSH_ORIGINAL_COMMAND:-} ]] || {
  printf '{"id":null,"ok":false,"done":true,"error":"remote commands are disabled"}\n'
  exit 126
}

dispatcher_user=$(id -un)
namespace_file="$DISPATCH_NAMESPACE_DIR/$dispatcher_user"
[[ -f "$namespace_file" && ! -L "$namespace_file" ]] || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher user is not mapped"}\n'
  exit 126
}
[[ $(stat -c '%U:%G' "$namespace_file") == root:root ]] || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher mapping is unsafe"}\n'
  exit 126
}
mapping_mode=$(stat -c '%a' "$namespace_file")
(((8#$mapping_mode & 8#022) == 0)) || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher mapping is unsafe"}\n'
  exit 126
}
namespace=$(<"$namespace_file")
expected_user=$("$SCRIPT_DIR/dispatcher-identity.sh" "$namespace") || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher mapping is invalid"}\n'
  exit 126
}
[[ "$dispatcher_user" == "$expected_user" ]] || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher mapping is invalid"}\n'
  exit 126
}

export HOME="$DISPATCH_RUNTIME_ROOT/$dispatcher_user"
[[ -d "$HOME" && ! -L "$HOME" && -w "$HOME" ]] || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher runtime is unavailable"}\n'
  exit 126
}
[[ $(stat -c '%U:%G:%a' "$HOME") == "$dispatcher_user:$DISPATCH_GROUP:700" ]] || {
  printf '{"id":null,"ok":false,"done":true,"error":"dispatcher runtime is unsafe"}\n'
  exit 126
}

exec /usr/local/libexec/echo-ai-agent-dispatch --namespace "$namespace"
