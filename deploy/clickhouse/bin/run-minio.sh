#!/usr/bin/env bash

set -euo pipefail

export MINIO_ROOT_USER
export MINIO_ROOT_PASSWORD

exec /usr/local/bin/minio server /var/lib/echo-analytics/minio \
  --address "127.0.0.1:${MINIO_API_PORT:-9002}" \
  --console-address "127.0.0.1:${MINIO_CONSOLE_PORT:-9003}"
