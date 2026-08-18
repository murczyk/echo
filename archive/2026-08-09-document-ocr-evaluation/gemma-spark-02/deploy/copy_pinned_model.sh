#!/usr/bin/env bash

set -euo pipefail

SOURCE_HOST=${SOURCE_HOST:-echo-gpu-spark}
DESTINATION_HOST=${DESTINATION_HOST:-echo-gpu-spark-02}
MODEL_REVISION=4d7ae4984b7db7de8f8457170b3f1a419ee76d52
SOURCE_SNAPSHOT=/home/echo/.cache/huggingface/hub/models--google--gemma-4-26B-A4B-it/snapshots/$MODEL_REVISION
DESTINATION_REPO=/srv/echo-gemma-ocr/cache/huggingface/hub/models--google--gemma-4-26B-A4B-it
GUARD='test "$(hostname)" = echo-gpu-spark-02 && test "$(tailscale ip -4)" = 100.95.57.33 && test "$(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits)" = GPU-a2db5163-9f88-101b-6db3-df4f83412d48'

ssh "$SOURCE_HOST" "test -d '$SOURCE_SNAPSHOT'"
ssh "$DESTINATION_HOST" "set -eu; $GUARD; install -d -m 0755 '$DESTINATION_REPO/snapshots/$MODEL_REVISION' '$DESTINATION_REPO/refs'"
ssh "$SOURCE_HOST" "tar -C '$SOURCE_SNAPSHOT' -chf - ." \
    | ssh "$DESTINATION_HOST" "set -eu; $GUARD; tar -C '$DESTINATION_REPO/snapshots/$MODEL_REVISION' -xf -"
ssh "$DESTINATION_HOST" "set -eu; $GUARD; printf '%s' '$MODEL_REVISION' > '$DESTINATION_REPO/refs/main'"

