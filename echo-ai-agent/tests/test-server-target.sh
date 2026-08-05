#!/usr/bin/env bash

set -euo pipefail

BUNDLE_DIR=$(cd "$(dirname "$0")/.." && pwd)
resolver="$BUNDLE_DIR/bin/server-target.sh"

[[ $("$resolver" bootstrap echo-ai-agent-vm) == echo-ai-agent-vm ]]
[[ $("$resolver" admin echo-ai-agent-vm) == echo@echo-ai-agent-vm.eagle-atria.ts.net ]]
[[ $("$resolver" dispatcher echo-ai-agent-vm) == echo-ai-agent-vm.eagle-atria.ts.net ]]

if "$resolver" admin echo-staging >/dev/null 2>&1; then
  printf 'server resolver accepted a non-agent host\n' >&2
  exit 1
fi

dry_run=$(cd "$BUNDLE_DIR" && just --dry-run preflight --server=echo-ai-agent-vm 2>&1)
[[ "$dry_run" == *'server-target.sh admin "echo-ai-agent-vm"'* ]]

if invalid_output=$(
  cd "$BUNDLE_DIR" && just preflight --server=echo-staging 2>&1
); then
  printf 'just recipe accepted a non-agent host\n' >&2
  exit 1
fi
[[ "$invalid_output" == *'unsupported --server: echo-staging; expected echo-ai-agent-vm'* ]]
[[ "$invalid_output" != *'preflight passed'* ]]

if missing_output=$(cd "$BUNDLE_DIR" && just --dry-run preflight 2>&1); then
  printf 'just recipe accepted a missing --server parameter\n' >&2
  exit 1
fi
expected_missing="Recipe \`preflight\` requires option \`--server\`"
[[ "$missing_output" == *"$expected_missing"* ]]

check_dangerous_recipe() {
  local dry_run
  local expected_acknowledgement
  local missing_acknowledgement
  local recipe=$1
  shift

  dry_run=$(cd "$BUNDLE_DIR" && just --dry-run "$recipe" "$@" \
    --server=echo-ai-agent-vm --dangerously-acknowledge 2>&1)
  [[ "$dry_run" == *'"true"'* ]]
  [[ "$dry_run" != *ECHO_AI_AGENT_CONFIRM* ]]

  if missing_acknowledgement=$(cd "$BUNDLE_DIR" && just --dry-run \
    "$recipe" "$@" --server=echo-ai-agent-vm 2>&1); then
    printf '%s accepted a missing dangerous-operation acknowledgement\n' "$recipe" >&2
    exit 1
  fi
  expected_acknowledgement="Recipe \`$recipe\` requires option \`--dangerously-acknowledge\`"
  [[ "$missing_acknowledgement" == *"$expected_acknowledgement"* ]]
}

check_dangerous_recipe setup
check_dangerous_recipe deploy-host
check_dangerous_recipe build-template
check_dangerous_recipe provision-key /tmp/echo-staging-ai-agent.pub \
  --echo-server=echo-staging
check_dangerous_recipe rollback

if missing_echo_server=$(cd "$BUNDLE_DIR" && just --dry-run provision-key \
  /tmp/echo-staging-ai-agent.pub --server=echo-ai-agent-vm \
  --dangerously-acknowledge 2>&1); then
  printf 'provision-key accepted a missing Echo server\n' >&2
  exit 1
fi
expected_echo_server="Recipe \`provision-key\` requires option \`--echo-server\`"
[[ "$missing_echo_server" == *"$expected_echo_server"* ]]
