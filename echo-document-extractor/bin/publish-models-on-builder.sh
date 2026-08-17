#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
BUILDER_HOST=${BUILDER_HOST:-echo-build-deb13-main}
[[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] \
  || { printf 'write-capable AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required\n' >&2; exit 1; }
command -v s5cmd >/dev/null || { printf 's5cmd is required locally\n' >&2; exit 1; }
# shellcheck source=/dev/null
source "$PROJECT_DIR/versions.env"
printf '%s  %s\n' "$S5CMD_BINARY_SHA256" "$(command -v s5cmd)" | sha256sum --check --status - \
  || { printf 'local s5cmd binary does not match versions.env\n' >&2; exit 1; }

credentials=$(mktemp /tmp/echo-document-extractor-model-rw.XXXXXX)
chmod 0600 "$credentials"
printf 'AWS_ACCESS_KEY_ID=%q\nAWS_SECRET_ACCESS_KEY=%q\n' \
  "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" >"$credentials"
remote=$(ssh -o BatchMode=yes "$BUILDER_HOST" mktemp -d /tmp/echo-document-extractor-publish.XXXXXX)
[[ "$remote" =~ ^/tmp/echo-document-extractor-publish\.[A-Za-z0-9]+$ ]] \
  || { printf 'builder returned unsafe staging path\n' >&2; exit 1; }
cleanup() {
  [[ "$credentials" == /tmp/echo-document-extractor-model-rw.* ]] && rm -f -- "$credentials"
  ssh -o BatchMode=yes "$BUILDER_HOST" rm -rf -- "$remote" >/dev/null 2>&1 || true
}
trap cleanup EXIT
tar -C "$PROJECT_DIR" --exclude=.venv --exclude=dist --exclude=.pytest_cache \
  --exclude=.ruff_cache --exclude=__pycache__ --exclude='*.pyc' -cf - . \
  | ssh -o BatchMode=yes "$BUILDER_HOST" tar -C "$remote" -xf -
scp -q "$credentials" "$BUILDER_HOST:$remote/model-rw.env"
scp -q "$(command -v s5cmd)" "$BUILDER_HOST:$remote/s5cmd"
ssh -o BatchMode=yes "$BUILDER_HOST" bash -s -- "$remote" <<'REMOTE'
set -euo pipefail
remote=$1
[[ -d /var/cache/echo-document-extractor/models ]] \
  || { printf 'builder model cache is absent\n' >&2; exit 1; }
chmod 0600 "$remote/model-rw.env"
chmod 0755 "$remote/s5cmd"
set -a
# shellcheck disable=SC1091
source "$remote/model-rw.env"
set +a
PATH="$remote:$PATH" MODEL_SOURCE_DIR=/var/cache/echo-document-extractor/models \
  "$remote/bin/publish-models.sh"
REMOTE
