#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
PACKAGE_VERSION=${PACKAGE_VERSION:?PACKAGE_VERSION is required}
OUTPUT_DIR=${OUTPUT_DIR:-$PROJECT_DIR/dist}
# shellcheck source=/dev/null
source "$PROJECT_DIR/versions.env"

for command_name in curl dpkg-deb sha256sum tar uv; do
  command -v "$command_name" >/dev/null \
    || { printf 'missing command: %s\n' "$command_name" >&2; exit 1; }
done
[[ $(python3 -c 'import sys; print(sys.version_info[:2] == (3, 13))') == True ]] \
  || { printf 'CPython 3.13 is required to build the application package\n' >&2; exit 1; }
[[ $(uv --version | awk '{print $2}') == "$UV_VERSION" ]] \
  || { printf 'builder uv version does not match versions.env\n' >&2; exit 1; }
printf '%s  %s\n' "$UV_BINARY_SHA256" "$(command -v uv)" | sha256sum --check --status - \
  || { printf 'builder uv binary does not match versions.env\n' >&2; exit 1; }
uv lock --check

stage=$(mktemp -d /tmp/echo-document-extractor-app.XXXXXX)
build=$(mktemp -d /tmp/echo-document-extractor-build.XXXXXX)
cleanup() {
  [[ "$stage" == /tmp/echo-document-extractor-app.* ]] && rm -rf -- "$stage"
  [[ "$build" == /tmp/echo-document-extractor-build.* ]] && rm -rf -- "$build"
}
trap cleanup EXIT
mkdir -p "$stage/DEBIAN" "$stage/opt/echo-document-extractor/bin" \
  "$stage/usr/lib/echo-document-extractor" \
  "$stage/usr/share/echo-document-extractor/runtime" \
  "$stage/usr/share/echo-document-extractor/schemas" \
  "$stage/lib/systemd/system" "$OUTPUT_DIR"

cp -a "$PROJECT_DIR/src/echo_document_extractor" \
  "$stage/usr/lib/echo-document-extractor/"
find "$stage/usr/lib/echo-document-extractor" -type d -name __pycache__ -prune \
  -exec rm -rf -- {} +
find "$stage/usr/lib/echo-document-extractor" -type d -exec chmod 0755 {} +
find "$stage/usr/lib/echo-document-extractor" -type f -exec chmod 0644 {} +
install -m 0644 "$PROJECT_DIR/pyproject.toml" "$PROJECT_DIR/uv.lock" \
  "$stage/usr/share/echo-document-extractor/runtime/"
install -m 0644 "$PROJECT_DIR/schemas/"*.json \
  "$stage/usr/share/echo-document-extractor/schemas/"
install -m 0755 "$(command -v uv)" "$stage/opt/echo-document-extractor/bin/uv"

s5_archive="$build/$S5CMD_ARCHIVE"
if [[ -n ${S5CMD_ARCHIVE_FILE:-} ]]; then
  cp "$S5CMD_ARCHIVE_FILE" "$s5_archive"
else
  curl -fsSL --retry 3 \
    "https://github.com/peak/s5cmd/releases/download/v$S5CMD_VERSION/$S5CMD_ARCHIVE" \
    -o "$s5_archive"
fi
printf '%s  %s\n' "$S5CMD_ARCHIVE_SHA256" "$s5_archive" \
  | sha256sum --check --status -
tar -xOzf "$s5_archive" s5cmd >"$stage/opt/echo-document-extractor/bin/s5cmd"
printf '%s  %s\n' "$S5CMD_BINARY_SHA256" "$stage/opt/echo-document-extractor/bin/s5cmd" \
  | sha256sum --check --status -

collector_archive="$build/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"
if [[ -n ${SIGNOZ_OTEL_COLLECTOR_ARCHIVE_FILE:-} ]]; then
  cp "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_FILE" "$collector_archive"
else
  curl -fsSL --retry 3 \
    "https://github.com/SigNoz/signoz-otel-collector/releases/download/v$SIGNOZ_OTEL_COLLECTOR_VERSION/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE" \
    -o "$collector_archive"
fi
printf '%s  %s\n' "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256" "$collector_archive" \
  | sha256sum --check --status -
member=signoz-otel-collector_linux_amd64/bin/signoz-otel-collector
tar -xOzf "$collector_archive" "$member" \
  >"$stage/opt/echo-document-extractor/bin/signoz-otel-collector"
printf '%s  %s\n' "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256" \
  "$stage/opt/echo-document-extractor/bin/signoz-otel-collector" \
  | sha256sum --check --status -

install -m 0755 "$PROJECT_DIR/bin/run-api" "$PROJECT_DIR/bin/run-worker" \
  "$PROJECT_DIR/bin/host-cpu-exporter.py" \
  "$PROJECT_DIR/bin/sync-runtime.sh" "$PROJECT_DIR/bin/sync-models.sh" \
  "$PROJECT_DIR/bin/verify-models.sh" "$PROJECT_DIR/bin/verify-offline-paddle.sh" \
  "$PROJECT_DIR/bin/configure-firewall.sh" "$stage/opt/echo-document-extractor/bin/"
chmod 0755 "$stage/opt/echo-document-extractor/bin/s5cmd" \
  "$stage/opt/echo-document-extractor/bin/signoz-otel-collector"
install -m 0644 "$PROJECT_DIR/systemd/"*.service "$stage/lib/systemd/system/"
install -m 0644 "$PROJECT_DIR/config/service.yaml" \
  "$stage/usr/share/echo-document-extractor/config.yaml"
install -m 0644 "$PROJECT_DIR/config/models.env" "$PROJECT_DIR/config/otel.env" \
  "$PROJECT_DIR/config/otel-collector.yaml" "$stage/usr/share/echo-document-extractor/"
install -m 0644 "$PROJECT_DIR/config/firewall-sources.conf" \
  "$stage/usr/share/echo-document-extractor/firewall-sources.conf"
cat >"$stage/DEBIAN/control" <<EOF
Package: echo-document-extractor
Version: $PACKAGE_VERSION
Architecture: amd64
Maintainer: Echo Operations
Section: misc
Priority: optional
Depends: python3 (>= 3.13), openssl, libgl1, libglib2.0-0t64, libgomp1, nftables
Description: Authenticated durable Echo document extraction service
EOF
install -m 0755 "$PROJECT_DIR/packaging/application/postinst" "$stage/DEBIAN/postinst"
install -m 0755 "$PROJECT_DIR/packaging/application/prerm" "$stage/DEBIAN/prerm"
dpkg-deb --build --root-owner-group "$stage" \
  "$OUTPUT_DIR/echo-document-extractor_${PACKAGE_VERSION}_amd64.deb"
