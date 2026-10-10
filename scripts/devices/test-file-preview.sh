#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
for preview_python in "${DEVICE_FILE_PREVIEW_PYTHON:-python3}" /opt/homebrew/bin/python3; do
    if "$preview_python" -c 'import tomllib' >/dev/null 2>&1; then
        exec "$preview_python" "$script_dir/file_preview_harness.py" "$@"
    fi
done
echo 'Device file preview harness requires Python 3.11 or newer.' >&2
exit 1
