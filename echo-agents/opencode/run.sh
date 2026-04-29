#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
OPENCODE_BIN=${OPENCODE_BIN:-opencode}

export OPENCODE_CONFIG="${OPENCODE_CONFIG:-$SCRIPT_DIR/opencode.jsonc}"
export OPENCODE_ENABLE_EXA=0
unset EXA_API_KEY

args=("$@")
if [[ -n "${OPENCODE_MODEL:-}" ]]; then
  has_model_arg=false
  for arg in "${args[@]}"; do
    case "$arg" in
      -m|--model|--model=*)
        has_model_arg=true
        break
        ;;
    esac
  done

  if [[ "$has_model_arg" == "false" ]]; then
    args=(--model "$OPENCODE_MODEL" "${args[@]}")
  fi
fi

cd "$PROJECT_ROOT"
exec "$OPENCODE_BIN" "${args[@]}"
