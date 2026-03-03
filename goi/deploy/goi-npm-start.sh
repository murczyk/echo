#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${GOI_APP_DIR:-/etc/goi}"
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

if [[ -n "${PORT:-}" ]]; then
  exec npm run start -- --port "${PORT}"
fi

exec npm run start
