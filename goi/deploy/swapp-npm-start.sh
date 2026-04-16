#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${SWAPP_APP_DIR:-${GOI_APP_DIR:-/etc/swapp}}"
export NVM_DIR="${NVM_DIR:-/home/echo/.nvm}"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "nvm is not installed: $NVM_DIR/nvm.sh" >&2
  exit 1
fi

# Load nvm.
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"

# Use whatever `nvm alias default` points to.
nvm use --silent default >/dev/null

cd "$APP_DIR"

NEXT_BIN="$APP_DIR/node_modules/.bin/next"

if [[ ! -x "$NEXT_BIN" ]]; then
  echo "next binary is not installed: $NEXT_BIN" >&2
  exit 1
fi

if [[ -n "${HOST:-}" && -n "${PORT:-}" ]]; then
  exec "$NEXT_BIN" start --hostname "${HOST}" --port "${PORT}"
fi

if [[ -n "${HOST:-}" ]]; then
  exec "$NEXT_BIN" start --hostname "${HOST}"
fi

if [[ -n "${PORT:-}" ]]; then
  exec "$NEXT_BIN" start --port "${PORT}"
fi

exec "$NEXT_BIN" start
