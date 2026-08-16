#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) == 0 ]] || { printf 'sync-runtime.sh must run as root\n' >&2; exit 1; }
root=/opt/echo-document-extractor/runtime
project=/usr/share/echo-document-extractor/runtime
uv=/opt/echo-document-extractor/bin/uv
cache=/var/cache/echo-document-extractor/uv
profile=${ECHO_DOCUMENT_EXTRACTOR_RUNTIME_PROFILE:-gpu}
[[ -x "$uv" && -f "$project/uv.lock" && -f "$project/pyproject.toml" ]] \
  || { printf 'packaged runtime inputs are incomplete\n' >&2; exit 1; }
lock_hash=$(sha256sum "$project/uv.lock" "$project/pyproject.toml" | sha256sum | cut -c1-24)
name="$profile-$lock_hash"
environment="$root/envs/$name"
install -d -m 0755 "$root/envs" "$cache"

if [[ ! -x "$environment/bin/python" ]] \
  || ! "$environment/bin/python" -c 'import fastapi, paddle, paddleocr, uvicorn' >/dev/null 2>&1; then
  install -d -m 0755 "$environment"
  (
    cd "$project"
    UV_PROJECT_ENVIRONMENT="$environment" UV_CACHE_DIR="$cache" \
      "$uv" sync --frozen --no-dev --extra "$profile" --no-install-project
  )
  "$environment/bin/python" -c 'import fastapi, paddle, paddleocr, uvicorn'
fi

temporary="$root/.current.$$.tmp"
ln -s "envs/$name" "$temporary"
mv -Tf "$temporary" "$root/current"
printf '%s\n' "$name"
