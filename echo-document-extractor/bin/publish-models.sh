#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
SOURCE_DIR=${MODEL_SOURCE_DIR:?MODEL_SOURCE_DIR must contain the complete Paddle model tree}
[[ -f "$SOURCE_DIR/PP-StructureV3.yaml" ]] \
  || { printf 'model source lacks PP-StructureV3.yaml\n' >&2; exit 1; }
for directory in PP-LCNet_x1_0_doc_ori UVDoc PP-OCRv5_server_det \
  PP-LCNet_x1_0_textline_ori eslav_PP-OCRv5_mobile_rec en_PP-OCRv5_mobile_rec; do
  [[ -d "$SOURCE_DIR/$directory" ]] \
    || { printf 'missing model directory: %s\n' "$directory" >&2; exit 1; }
  find "$SOURCE_DIR/$directory" -type f -size +0c -print -quit | grep -q . \
    || { printf 'empty model directory: %s\n' "$directory" >&2; exit 1; }
done
[[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] \
  || { printf 'write-capable AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required\n' >&2; exit 1; }
set -a
# shellcheck source=/dev/null
source "$PROJECT_DIR/config/models.env"
set +a
endpoint=$ECHO_DOCUMENT_EXTRACTOR_MODELS_ENDPOINT
prefix=${ECHO_DOCUMENT_EXTRACTOR_MODELS_PREFIX%/}
temporary=$(mktemp -d /tmp/echo-document-extractor-model-publish.XXXXXX)
trap '[[ "$temporary" == /tmp/echo-document-extractor-model-publish.* ]] && rm -rf -- "$temporary"' EXIT
manifest="$temporary/manifest.json"
PYTHONPATH="$PROJECT_DIR/src" python3 -m echo_document_extractor.model_store \
  create --source "$SOURCE_DIR" --output "$manifest" >/dev/null
while IFS=$'\t' read -r _digest _size relative; do
  s5cmd --endpoint-url "$endpoint" cp --if-source-newer "$SOURCE_DIR/$relative" "$prefix/$relative"
done < <(PYTHONPATH="$PROJECT_DIR/src" python3 -m echo_document_extractor.model_store \
  missing --manifest "$manifest" --objects "$temporary/objects")
s5cmd --endpoint-url "$endpoint" cp "$manifest" "$prefix/manifest.json"
printf 'published model manifest %s\n' \
  "$(PYTHONPATH="$PROJECT_DIR/src" python3 -m echo_document_extractor.model_store id --manifest "$manifest")"
