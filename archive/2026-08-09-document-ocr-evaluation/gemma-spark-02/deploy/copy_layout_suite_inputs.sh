#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_DIR=${1:-/var/tmp/14AUG26}
MANIFEST=${2:-$ROOT/layout-suite-manifest.json}
DESTINATION_HOST=${DESTINATION_HOST:-echo-gpu-spark-02}
DESTINATION_DIR=/srv/echo-gemma-ocr/input
GUARD='test "$(hostname)" = echo-gpu-spark-02 && test "$(tailscale ip -4)" = 100.95.57.33 && test "$(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits)" = GPU-a2db5163-9f88-101b-6db3-df4f83412d48'

mapfile -t FILENAMES < <(python3 - "$MANIFEST" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
for document in manifest["documents"]:
    for page in document["pages"]:
        print(page["filename"])
PY
)

EXPECTED=$(mktemp)
trap 'rm -f "$EXPECTED"' EXIT
python3 - "$MANIFEST" >"$EXPECTED" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
for document in manifest["documents"]:
    for page in document["pages"]:
        print(f'{page["sha256"]}  {page["filename"]}')
PY

(cd "$SOURCE_DIR" && sha256sum -c "$EXPECTED")
tar -C "$SOURCE_DIR" -cf - "${FILENAMES[@]}" \
    | ssh "$DESTINATION_HOST" "set -eu; $GUARD; install -d -m 0700 '$DESTINATION_DIR'; tar -C '$DESTINATION_DIR' -xf -; chmod 0600 '$DESTINATION_DIR'/*"
ssh "$DESTINATION_HOST" "set -eu; $GUARD; cd '$DESTINATION_DIR'; sha256sum -c -" <"$EXPECTED"
