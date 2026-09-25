#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_EVENT_NAME:-}" != "push" || "${GITHUB_REF:-}" != "refs/heads/stable" ]]; then
  echo "CI release stages require a push to stable." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -z "${GITHUB_SHA:-}" || "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$GITHUB_SHA" ]]; then
  echo "CI release checkout does not match GITHUB_SHA; refusing to use another run's artifacts." >&2
  exit 1
fi
