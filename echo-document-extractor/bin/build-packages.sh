#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
MODEL_SOURCE_DIR=${MODEL_SOURCE_DIR:?MODEL_SOURCE_DIR must contain the complete offline Paddle model tree}
cd "$PROJECT_DIR"
base_version=$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')
tree_hash=$(find . -type f \
  ! -path './.venv/*' ! -path './dist/*' ! -path './.pytest_cache/*' ! -path './.ruff_cache/*' \
  ! -path '*/__pycache__/*' ! -name '*.pyc' \
  -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
model_hash=$(
  cd "$MODEL_SOURCE_DIR"
  find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12
)
export PACKAGE_VERSION=${PACKAGE_VERSION:-${base_version}+3110.${tree_hash}.${model_hash}}
export OUTPUT_DIR=${OUTPUT_DIR:-$PROJECT_DIR/dist}
"$SCRIPT_DIR/build-model-package.sh"
"$SCRIPT_DIR/build-application-package.sh"
