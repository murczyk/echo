#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

connection_mode=${1:?connection mode is required}
server=${2:?server is required}

load_bundle
[[ "$server" == "$EXPECTED_HOSTNAME" ]] \
  || die "unsupported --server: $server; expected $EXPECTED_HOSTNAME"

case "$connection_mode" in
  admin)
    printf '%s\n' "$DEFAULT_ADMIN_HOST"
    ;;
  bootstrap)
    printf '%s\n' "$DEFAULT_BOOTSTRAP_HOST"
    ;;
  dispatcher)
    printf '%s\n' "${DEFAULT_ADMIN_HOST#*@}"
    ;;
  *)
    die "unsupported server connection mode: $connection_mode"
    ;;
esac
