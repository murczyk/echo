#!/usr/bin/env bash

set -euo pipefail

namespace=${1:?Echo server namespace is required}

[[ "$namespace" =~ ^echo-[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$ ]] || {
  printf '[echo-ai-agent] ERROR: invalid Echo server namespace: %s\n' "$namespace" >&2
  exit 1
}

dispatcher_user="echo-ai-agent-${namespace#echo-}"
if ((${#dispatcher_user} > 32)); then
  namespace_hash=$(printf '%s' "$namespace" | sha256sum | cut -c1-16)
  dispatcher_user="echo-ai-agent-$namespace_hash"
fi

printf '%s\n' "$dispatcher_user"
