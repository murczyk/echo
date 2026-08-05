#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

TABLE_FILE=/etc/echo-ai-agent/echo-ai-agent.nft
batch=

cleanup() {
  if [[ -n "$batch" && "$batch" =~ ^/run/echo-ai-agent-nft\.[A-Za-z0-9]+$ ]]; then
    rm -f -- "$batch"
  fi
}
trap cleanup EXIT

[[ $EUID -eq 0 ]] || {
  printf '[echo-ai-agent] ERROR: firewall must be applied as root\n' >&2
  exit 1
}
batch=$(mktemp /run/echo-ai-agent-nft.XXXXXX)
if nft list table inet echo_ai_agent >/dev/null 2>&1; then
  printf 'delete table inet echo_ai_agent\n' >"$batch"
fi
if nft list table bridge echo_ai_agent_bridge >/dev/null 2>&1; then
  printf 'delete table bridge echo_ai_agent_bridge\n' >>"$batch"
fi
cat "$TABLE_FILE" >>"$batch"
nft --check --file "$batch"
nft --file "$batch"
