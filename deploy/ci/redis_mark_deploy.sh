#!/usr/bin/env bash
set -euo pipefail

# Mark deploy status in Redis on echo-ci.
# Usage: redis_mark_deploy.sh started|finished

ACTION=${1:-}
if [[ "$ACTION" != "started" && "$ACTION" != "finished" ]]; then
  echo "Usage: $0 started|finished" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Determine version from root Cargo.toml ([workspace.package].version)
VERSION=$(tq -f Cargo.toml workspace.package.version)

if [[ -z "${VERSION:-}" ]]; then
  echo "Failed to detect version from Cargo.toml" >&2
  exit 1
fi

: "${ECHO_CI_REPO:=echo}"
: "${ECHO_CI_SSH_HOST:=echo-ci.eagle-atria.ts.net}"
: "${ECHO_CI_SSH_USER:=echo}"

KEY="echo-ci:deploy:${ECHO_CI_REPO}:${ACTION}:${VERSION}"

# Prepare SSH if key is provided (same as publish script)
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keyscan -H "$ECHO_CI_SSH_HOST" >> ~/.ssh/known_hosts 2>/dev/null || true

SSH_IDENTITY_ARGS=()
if [[ -n "${ECHO_CI_SSH_KEY:-}" ]]; then
  echo "$ECHO_CI_SSH_KEY" > ~/.ssh/echo_ci
  chmod 600 ~/.ssh/echo_ci
  SSH_IDENTITY_ARGS=(-i ~/.ssh/echo_ci)
fi

echo "Setting Redis key on $ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST: $KEY=1 (EX 86400)"
ssh "${SSH_IDENTITY_ARGS[@]}" "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" \
  redis-cli SETEX "$KEY" 86400 1 >/dev/null
echo "Set $KEY"

