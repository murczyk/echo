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
VERSION=$(tq -r -f Cargo.toml workspace.package.version)

if [[ -z "${VERSION:-}" ]]; then
  echo "Failed to detect version from Cargo.toml" >&2
  exit 1
fi

: "${ECHO_CI_REPO:=echo}"

KEY="echo-ci:deploy:${ECHO_CI_REPO}:${ACTION}:${VERSION}"

echo "Setting Redis key locally: $KEY=1 (EX 86400)"
redis-cli SETEX "$KEY" 86400 1 >/dev/null
echo "Set $KEY"
