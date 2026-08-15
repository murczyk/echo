#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
SOURCE_DIR=${MODEL_SOURCE_DIR:?MODEL_SOURCE_DIR must contain the complete offline Paddle model tree}
PACKAGE_VERSION=${PACKAGE_VERSION:?PACKAGE_VERSION is required}
OUTPUT_DIR=${OUTPUT_DIR:-$PROJECT_DIR/dist}

[[ -d "$SOURCE_DIR" ]] || { printf 'model source is not a directory: %s\n' "$SOURCE_DIR" >&2; exit 1; }
[[ -f "$SOURCE_DIR/PP-StructureV3.yaml" ]] \
  || { printf 'model source lacks PP-StructureV3.yaml\n' >&2; exit 1; }
for command_name in dpkg-deb python3 sha256sum; do
  command -v "$command_name" >/dev/null \
    || { printf 'missing command: %s\n' "$command_name" >&2; exit 1; }
done
for directory in PP-LCNet_x1_0_doc_ori UVDoc PP-OCRv5_server_det \
  PP-LCNet_x1_0_textline_ori eslav_PP-OCRv5_mobile_rec en_PP-OCRv5_mobile_rec; do
  [[ -d "$SOURCE_DIR/$directory" ]] || { printf 'missing model directory: %s\n' "$directory" >&2; exit 1; }
  find "$SOURCE_DIR/$directory" -type f -size +0c -print -quit | grep -q . \
    || { printf 'empty model directory: %s\n' "$directory" >&2; exit 1; }
done
python3 - "$SOURCE_DIR" <<'PY'
import sys
from pathlib import Path
import yaml

source = Path(sys.argv[1]).resolve()
root = Path("/opt/echo-document-extractor/models")
config = yaml.safe_load((source / "PP-StructureV3.yaml").read_text())
count = 0

def visit(value):
    global count
    if isinstance(value, dict):
        if value.get("model_dir") is not None:
            count += 1
            path = Path(str(value["model_dir"]))
            try:
                relative = path.relative_to(root)
            except ValueError as error:
                raise SystemExit(f"model_dir is outside production root: {path}") from error
            directory = source / relative
            if not directory.is_dir():
                raise SystemExit(f"model_dir is absent from package source: {relative}")
            if not any(path.is_file() and path.stat().st_size for path in directory.rglob("*")):
                raise SystemExit(f"model_dir is empty: {relative}")
        for nested in value.values():
            visit(nested)
    elif isinstance(value, list):
        for nested in value:
            visit(nested)

visit(config)
if count < 5:
    raise SystemExit("PP-StructureV3.yaml does not pin all model directories")
PY

stage=$(mktemp -d /tmp/echo-document-extractor-models.XXXXXX)
trap '[[ "$stage" == /tmp/echo-document-extractor-models.* ]] && rm -rf -- "$stage"' EXIT
root="$stage/opt/echo-document-extractor/models"
mkdir -p "$root" "$stage/DEBIAN" "$OUTPUT_DIR"
cp -a "$SOURCE_DIR/." "$root/"
find "$root" -type l -print -quit | grep -q . \
  && { printf 'model package must not contain symbolic links\n' >&2; exit 1; }
(
  cd "$root"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum >"$stage/SHA256SUMS"
  mv "$stage/SHA256SUMS" SHA256SUMS
)
cat >"$stage/DEBIAN/control" <<EOF
Package: echo-document-extractor-models
Version: $PACKAGE_VERSION
Architecture: amd64
Maintainer: Echo Operations
Section: misc
Priority: optional
Description: Immutable offline Paddle models for Echo Document Extractor
EOF
install -m 0755 "$PROJECT_DIR/packaging/models/postinst" "$stage/DEBIAN/postinst"
dpkg-deb --build --root-owner-group "$stage" \
  "$OUTPUT_DIR/echo-document-extractor-models_${PACKAGE_VERSION}_amd64.deb"
