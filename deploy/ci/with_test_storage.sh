#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV="$REPO_ROOT/target/ci-test-storage-venv"
REQUIREMENTS="$SCRIPT_DIR/test-storage-requirements.txt"

if [[ ! -x "$VENV/bin/python" ]]; then
    python3 -m venv "$VENV"
fi
if ! cmp -s "$REQUIREMENTS" "$VENV/requirements-installed.txt"; then
    "$VENV/bin/python" -m pip install --disable-pip-version-check -r "$REQUIREMENTS"
    cp "$REQUIREMENTS" "$VENV/requirements-installed.txt"
fi

exec "$VENV/bin/python" "$SCRIPT_DIR/with_test_storage.py" "$@"
