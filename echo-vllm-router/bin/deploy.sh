#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_TARGET_HOST}
artifact_dir=
remote_root=

cleanup() {
  if [[ -n "$artifact_dir" && "$artifact_dir" == /tmp/echo-vllm-router-artifacts.* ]]; then
    rm -rf -- "$artifact_dir"
  fi
  if [[ -n "$remote_root" && "$remote_root" =~ ^/tmp/echo-vllm-router-deploy\.[A-Za-z0-9]+$ ]]; then
    ssh -o BatchMode=yes "$target_host" rm -rf -- "$remote_root" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

prepare_wheelhouse() {
  mkdir -p "$artifact_dir/wheelhouse"
  python3 -m pip download \
    --disable-pip-version-check \
    --quiet \
    --dest "$artifact_dir/wheelhouse" \
    --only-binary=:all: \
    --platform manylinux_2_28_x86_64 \
    --platform manylinux2014_x86_64 \
    --implementation cp \
    --python-version 313 \
    --abi cp313 \
    --require-hashes \
    --requirement "$REQUIREMENTS_FILE"
  printf '%s  %s\n' \
    "$VLLM_ROUTER_WHEEL_SHA256" \
    "$artifact_dir/wheelhouse/$VLLM_ROUTER_WHEEL" \
    | sha256sum --check --status - \
    || die "downloaded router wheel checksum mismatch"
}

prepare_collector() {
  local archive="$artifact_dir/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"
  local binary_member="signoz-otel-collector_linux_amd64/bin/signoz-otel-collector"
  local binary_sha256
  local collector_url="https://github.com/SigNoz/signoz-otel-collector/releases/download/v$SIGNOZ_OTEL_COLLECTOR_VERSION/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"

  curl -fsSL --retry 3 --output "$archive" "$collector_url"
  printf '%s  %s\n' "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256" "$archive" \
    | sha256sum --check --status - \
    || die "downloaded collector archive checksum mismatch"
  binary_sha256=$(tar -xOzf "$archive" "$binary_member" | sha256sum | awk '{print $1}')
  [[ "$binary_sha256" == "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256" ]] \
    || die "downloaded collector binary checksum mismatch"
}

upload_stage() {
  remote_root=$(ssh -o BatchMode=yes "$target_host" mktemp -d /tmp/echo-vllm-router-deploy.XXXXXX)
  [[ "$remote_root" =~ ^/tmp/echo-vllm-router-deploy\.[A-Za-z0-9]+$ ]] \
    || die "target returned an unsafe staging directory"
  ssh -o BatchMode=yes "$target_host" mkdir -p \
    "$remote_root/bundle" \
    "$remote_root/artifacts/wheelhouse"
  tar -C "$BUNDLE_DIR" -cf - . \
    | ssh -o BatchMode=yes "$target_host" tar -C "$remote_root/bundle" -xf -
  tar -C "$artifact_dir/wheelhouse" -cf - . \
    | ssh -o BatchMode=yes "$target_host" tar -C "$remote_root/artifacts/wheelhouse" -xf -
  scp -q \
    "$artifact_dir/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE" \
    "$target_host:$remote_root/artifacts/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"
}

require_cmd curl
require_cmd python3
require_cmd scp
require_cmd sha256sum
require_cmd ssh
require_cmd tar
python3 -m pip --version >/dev/null || die "python3 pip is unavailable"
validate_bundle

artifact_dir=$(mktemp -d /tmp/echo-vllm-router-artifacts.XXXXXX)
prepare_wheelhouse
prepare_collector
run_remote_preflight "$target_host"
upload_stage
ssh -o BatchMode=yes "$target_host" \
  sudo "$remote_root/bundle/bin/install-remote.sh" "$remote_root"
"$SCRIPT_DIR/verify.sh" "$target_host"
