#!/usr/bin/env bash

set -euo pipefail

BUNDLE_DIR=$(cd "$(dirname "$0")/.." && pwd)
identity="$BUNDLE_DIR/bin/dispatcher-identity.sh"

[[ $($identity echo-staging) == echo-ai-agent-staging ]]
[[ $($identity echo-cbr-staging) == echo-ai-agent-cbr-staging ]]
[[ $($identity echo-cbr) == echo-ai-agent-cbr ]]
[[ $($identity echo-kharkiv2) == echo-ai-agent-kharkiv2 ]]

long_namespace=echo-abcdefghijklmnopqrstuvwxyz1234567890
long_user=$($identity "$long_namespace")
[[ "$long_user" =~ ^echo-ai-agent-[0-9a-f]{16}$ ]]
[[ $($identity "$long_namespace") == "$long_user" ]]
[[ $($identity echo-abcdefghijklmnopqrstuvwxyz1234567891) != "$long_user" ]]

for invalid_namespace in echo- Echo-cbr echo-cbr- other-cbr; do
  if "$identity" "$invalid_namespace" >/dev/null 2>&1; then
    printf 'dispatcher identity accepted invalid namespace: %s\n' \
      "$invalid_namespace" >&2
    exit 1
  fi
done

just_user=$(cd "$BUNDLE_DIR" && \
  just dispatcher-user --echo-server=echo-cbr-staging)
[[ "$just_user" == echo-ai-agent-cbr-staging ]]
