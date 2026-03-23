#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
OPENCODE_BIN=${OPENCODE_BIN:-opencode}

export OPENCODE_CONFIG="${OPENCODE_CONFIG:-$SCRIPT_DIR/opencode.jsonc}"
export OPENCODE_ENABLE_EXA=0
unset EXA_API_KEY

cd "$PROJECT_ROOT"
exec "$OPENCODE_BIN" "$@"
