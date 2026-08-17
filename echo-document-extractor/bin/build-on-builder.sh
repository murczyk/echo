#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
BUILDER_HOST=${BUILDER_HOST:-echo-build-deb13-main}
ssh -o BatchMode=yes "$BUILDER_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]]
[[ $(dpkg --print-architecture) == amd64 ]]
[[ $(python3 -c 'import sys; print(sys.version_info[:2] == (3, 13))') == True ]]
command -v uv >/dev/null || { printf 'uv is not installed on the builder\n' >&2; exit 1; }
REMOTE
remote=$(ssh -o BatchMode=yes "$BUILDER_HOST" mktemp -d /tmp/echo-document-extractor-build.XXXXXX)
[[ "$remote" =~ ^/tmp/echo-document-extractor-build\.[A-Za-z0-9]+$ ]] \
  || { printf 'builder returned unsafe staging path\n' >&2; exit 1; }
cleanup() {
  ssh -o BatchMode=yes "$BUILDER_HOST" rm -rf -- "$remote" >/dev/null 2>&1 || true
}
trap cleanup EXIT
tar -C "$PROJECT_DIR" --exclude=.venv --exclude=dist --exclude=.pytest_cache \
  --exclude=.ruff_cache --exclude=__pycache__ --exclude='*.pyc' -cf - . \
  | ssh -o BatchMode=yes "$BUILDER_HOST" tar -C "$remote" -xf -
ssh -o BatchMode=yes "$BUILDER_HOST" \
  "cd '$remote' && ./bin/build-packages.sh"
mkdir -p "$PROJECT_DIR/dist"
scp -q "$BUILDER_HOST:$remote/dist/echo-document-extractor_"'*.deb' "$PROJECT_DIR/dist/"
