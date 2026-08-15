#!/usr/bin/env bash

set -euo pipefail

SOURCE_DIR=${1:?usage: copy_inputs.sh /path/to/source-images}
DESTINATION_HOST=${DESTINATION_HOST:-echo-gpu-spark-02}
DESTINATION_DIR=/srv/echo-gemma-ocr/input
J5_FILENAME=J5rHE_ZMsk1H_QDCCn3v.jpg
J5_SHA256=28f4104b68166bdc60de3d6d91b47a4498591b30e422adb70faafad6ec07f8cf
L54_FILENAME=l54dw_8gZt5foedpH-PY.jpg
L54_SHA256=228a267a2a95eb746265eb2f32c0a3f14053b22d8657a3defd8defd834ee8d60
GUARD='test "$(hostname)" = echo-gpu-spark-02 && test "$(tailscale ip -4)" = 100.95.57.33 && test "$(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits)" = GPU-a2db5163-9f88-101b-6db3-df4f83412d48'

test "$(sha256sum "$SOURCE_DIR/$J5_FILENAME" | awk '{print $1}')" = "$J5_SHA256"
test "$(sha256sum "$SOURCE_DIR/$L54_FILENAME" | awk '{print $1}')" = "$L54_SHA256"

tar -C "$SOURCE_DIR" -cf - "$J5_FILENAME" "$L54_FILENAME" \
    | ssh "$DESTINATION_HOST" "set -eu; $GUARD; install -d -m 0700 '$DESTINATION_DIR'; tar -C '$DESTINATION_DIR' -xf -; chmod 0600 '$DESTINATION_DIR/$J5_FILENAME' '$DESTINATION_DIR/$L54_FILENAME'"

ssh "$DESTINATION_HOST" "set -eu; $GUARD; test \"\$(sha256sum '$DESTINATION_DIR/$J5_FILENAME' | awk '{print \$1}')\" = '$J5_SHA256'; test \"\$(sha256sum '$DESTINATION_DIR/$L54_FILENAME' | awk '{print \$1}')\" = '$L54_SHA256'"
