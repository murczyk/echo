#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
PACKAGE_VERSION=${PACKAGE_VERSION:?PACKAGE_VERSION is required}
OUTPUT_DIR=${OUTPUT_DIR:-$PROJECT_DIR/dist}
# shellcheck source=versions.env
source "$PROJECT_DIR/versions.env"

for command_name in curl dpkg-deb sed sha256sum tar uv; do
  command -v "$command_name" >/dev/null || { printf 'missing command: %s\n' "$command_name" >&2; exit 1; }
done
[[ $(python3 -c 'import sys; print(sys.version_info[:2] == (3, 13))') == True ]] \
  || { printf 'CPython 3.13 is required to build the application package\n' >&2; exit 1; }
uv lock --check

stage=$(mktemp -d /tmp/echo-document-extractor-app.XXXXXX)
build=$(mktemp -d /tmp/echo-document-extractor-build.XXXXXX)
cleanup() {
  [[ "$stage" == /tmp/echo-document-extractor-app.* ]] && rm -rf -- "$stage"
  [[ "$build" == /tmp/echo-document-extractor-build.* ]] && rm -rf -- "$build"
}
trap cleanup EXIT
mkdir -p "$stage/DEBIAN" "$stage/opt/echo-document-extractor/python" \
  "$stage/opt/echo-document-extractor/bin" "$stage/usr/share/echo-document-extractor" \
  "$stage/lib/systemd/system" "$OUTPUT_DIR"

uv build --quiet --wheel --out-dir "$build/dist"
uv export --quiet --frozen --no-dev --extra gpu --no-emit-project --format requirements-txt \
  --output-file "$build/requirements.txt"
sed -i '/^paddlepaddle==/d; /^paddlepaddle-gpu==/d' "$build/requirements.txt"
uv pip install --quiet --target "$stage/opt/echo-document-extractor/python" \
  --requirements "$build/requirements.txt"
if [[ -n ${PADDLEPADDLE_WHEEL_FILE:-} ]]; then
  cp "$PADDLEPADDLE_WHEEL_FILE" "$build/$PADDLEPADDLE_WHEEL"
else
  curl -fsSL --retry 3 "$PADDLEPADDLE_WHEEL_URL" -o "$build/$PADDLEPADDLE_WHEEL"
fi
printf '%s  %s\n' "$PADDLEPADDLE_WHEEL_SHA256" "$build/$PADDLEPADDLE_WHEEL" \
  | sha256sum --check --status -
uv pip install --quiet --target "$stage/opt/echo-document-extractor/python" \
  --no-deps "$build/$PADDLEPADDLE_WHEEL"
uv pip install --quiet --target "$stage/opt/echo-document-extractor/python" \
  --no-deps "$build"/dist/*.whl
rm -f "$stage/opt/echo-document-extractor/python/.lock"

archive="$build/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"
if [[ -n ${SIGNOZ_OTEL_COLLECTOR_ARCHIVE_FILE:-} ]]; then
  cp "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_FILE" "$archive"
else
  curl -fsSL --retry 3 \
    "https://github.com/SigNoz/signoz-otel-collector/releases/download/v$SIGNOZ_OTEL_COLLECTOR_VERSION/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE" \
    -o "$archive"
fi
printf '%s  %s\n' "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256" "$archive" \
  | sha256sum --check --status -
member=signoz-otel-collector_linux_amd64/bin/signoz-otel-collector
tar -xOzf "$archive" "$member" >"$stage/opt/echo-document-extractor/bin/signoz-otel-collector"
printf '%s  %s\n' "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256" \
  "$stage/opt/echo-document-extractor/bin/signoz-otel-collector" \
  | sha256sum --check --status -

install -m 0755 "$PROJECT_DIR/bin/run-api" "$PROJECT_DIR/bin/run-worker" \
  "$PROJECT_DIR/bin/verify-offline-paddle.sh" "$PROJECT_DIR/bin/configure-firewall.sh" \
  "$stage/opt/echo-document-extractor/bin/"
install -m 0644 "$PROJECT_DIR/systemd/"*.service "$stage/lib/systemd/system/"
install -m 0644 "$PROJECT_DIR/config/service.yaml" \
  "$stage/usr/share/echo-document-extractor/config.yaml"
install -m 0644 "$PROJECT_DIR/config/otel.env" "$PROJECT_DIR/config/otel-collector.yaml" \
  "$stage/usr/share/echo-document-extractor/"
install -m 0644 "$PROJECT_DIR/config/firewall-sources.conf" \
  "$stage/usr/share/echo-document-extractor/firewall-sources.conf"
cat >"$stage/DEBIAN/control" <<EOF
Package: echo-document-extractor
Version: $PACKAGE_VERSION
Architecture: amd64
Maintainer: Echo Operations
Section: misc
Priority: optional
Depends: echo-document-extractor-models (= $PACKAGE_VERSION), python3 (>= 3.13), openssl, libgl1, libglib2.0-0t64, libgomp1, nftables
Description: Authenticated durable Echo document extraction service
EOF
install -m 0755 "$PROJECT_DIR/packaging/application/postinst" "$stage/DEBIAN/postinst"
install -m 0755 "$PROJECT_DIR/packaging/application/prerm" "$stage/DEBIAN/prerm"
chmod 0755 "$stage/opt/echo-document-extractor/bin/signoz-otel-collector"
dpkg-deb --build --root-owner-group "$stage" \
  "$OUTPUT_DIR/echo-document-extractor_${PACKAGE_VERSION}_amd64.deb"
