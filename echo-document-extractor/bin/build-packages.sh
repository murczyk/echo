#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"
base_version=$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')
tree_hash=$(find \
  bin/build-application-package.sh bin/configure-firewall.sh bin/run-api bin/run-worker \
  bin/sync-models.sh bin/sync-runtime.sh bin/verify-models.sh bin/verify-offline-paddle.sh \
  config/firewall-sources.conf config/models.env config/otel-collector.yaml config/otel.env \
  config/service.yaml packaging/application pyproject.toml schemas src systemd uv.lock versions.env \
  -type f ! -path '*/__pycache__/*' ! -name '*.pyc' \
  -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
export PACKAGE_VERSION=${PACKAGE_VERSION:-${base_version}+3110.${tree_hash}}
export OUTPUT_DIR=${OUTPUT_DIR:-$PROJECT_DIR/dist}
"$SCRIPT_DIR/build-application-package.sh"
