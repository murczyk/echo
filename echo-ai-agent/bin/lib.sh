#!/usr/bin/env bash

export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}:/usr/local/sbin:/usr/sbin:/sbin"

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
HOST_CONFIG_FILE="$BUNDLE_DIR/config/host.env"
VERSIONS_FILE="$BUNDLE_DIR/versions.env"
# shellcheck disable=SC2034  # Consumed by scripts that source this library.
DEFAULT_ADMIN_HOST=echo@echo-ai-agent-vm.eagle-atria.ts.net
# shellcheck disable=SC2034  # Consumed by scripts that source this library.
DEFAULT_BOOTSTRAP_HOST=echo-ai-agent-vm
ADMIN_HOST_KEY_ALIAS='[echo-ai-agent-vm.eagle-atria.ts.net]:22031'

log() {
  printf '[echo-ai-agent] %s\n' "$*"
}

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

require_sha256() {
  [[ "$2" =~ ^[0-9a-f]{64}$ ]] || die "invalid SHA-256 for $1"
}

ssh_target() {
  local connection_mode=$1
  local target_host=$2
  shift 2

  case "$connection_mode" in
    admin)
      command ssh \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o "HostKeyAlias=$ADMIN_HOST_KEY_ALIAS" \
        "$target_host" "$@"
      ;;
    bootstrap)
      command ssh -o BatchMode=yes -o ConnectTimeout=10 "$target_host" "$@"
      ;;
    *)
      die "unsupported SSH connection mode: $connection_mode"
      ;;
  esac
}

scp_to_target() {
  local connection_mode=$1
  local source_file=$2
  local target_host=$3
  local target_path=$4

  case "$connection_mode" in
    admin)
      command scp \
        -q \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o "HostKeyAlias=$ADMIN_HOST_KEY_ALIAS" \
        "$source_file" "$target_host:$target_path"
      ;;
    bootstrap)
      command scp -q -o BatchMode=yes -o ConnectTimeout=10 \
        "$source_file" "$target_host:$target_path"
      ;;
    *)
      die "unsupported SCP connection mode: $connection_mode"
      ;;
  esac
}

load_bundle() {
  require_file "$HOST_CONFIG_FILE"
  require_file "$VERSIONS_FILE"
  # shellcheck disable=SC1090
  source "$HOST_CONFIG_FILE"
  # shellcheck disable=SC1090
  source "$VERSIONS_FILE"
}

validate_bundle() {
  local lock_integrity
  local package_version

  load_bundle
  require_sha256 NODE_ARCHIVE_SHA256 "$NODE_ARCHIVE_SHA256"
  require_sha256 PI_TARBALL_SHA256 "$PI_TARBALL_SHA256"
  [[ "$EXPECTED_HOSTNAME" == echo-ai-agent-vm ]] || die "unexpected target hostname"
  [[ "$STORAGE_DISK" == /dev/sda ]] || die "unexpected storage disk"
  [[ "$STORAGE_LOGICAL_SECTOR_BYTES" == 512 ]] \
    || die "unexpected storage logical sector size"
  [[ "$STORAGE_ROOT_PARTITION" == /dev/sda1 ]] \
    || die "unexpected root partition"
  [[ "$STORAGE_ROOT_START_SECTOR" == 2048 ]] \
    || die "unexpected root partition start"
  [[ "$STORAGE_ROOT_SECTORS" == 124997632 ]] \
    || die "unexpected root partition size"
  [[ "$STORAGE_ROOT_FSTYPE" == ext4 ]] || die "unexpected root filesystem"
  [[ "$STORAGE_ROOT_MOUNTPOINT" == / ]] || die "unexpected root mountpoint"
  [[ "$STORAGE_PARTITION" == /dev/sda2 ]] || die "unexpected storage partition"
  [[ "$STORAGE_PARTITION_NUMBER" == 2 ]] || die "unexpected partition number"
  [[ "$STORAGE_MARKER" == /var/lib/echo-ai-agent/storage-partition-created ]] \
    || die "unexpected storage marker path"
  [[ "$STORAGE_VG" == ai-agents ]] || die "unexpected storage VG"
  [[ "$STORAGE_THINPOOL" == IncusThinPool ]] || die "unexpected storage thin pool"
  [[ "$AGENT_BRIDGE_IPV4" == 10.43.74.1/24 ]] || die "unexpected bridge network"
  [[ "$AGENT_MAX_RUNNING" == 6 ]] || die "unexpected running-container limit"
  [[ "$AGENT_CONTAINER_USER" == echo ]] || die "unexpected container user"
  [[ "$AGENT_CONTAINER_UID" == 29720 ]] || die "unexpected container UID"
  [[ "$AGENT_CONTAINER_GID" == 29720 ]] || die "unexpected container GID"
  [[ "$DISPATCH_PORT" == 22031 ]] || die "unexpected dispatcher port"
  [[ "$DISPATCH_NAMESPACE_DIR" == /etc/echo-ai-agent/namespaces ]] \
    || die "unexpected dispatcher namespace directory"
  [[ "$DISPATCH_RUNTIME_ROOT" == /run/echo-ai-agent-dispatcher ]] \
    || die "unexpected dispatcher runtime root"
  [[ "$DISPATCH_LOCK_PATH" == /run/lock/echo-ai-agent-dispatcher.lock ]] \
    || die "unexpected dispatcher lock path"
  [[ "$DISPATCH_VERIFY_NAMESPACE" == echo-verification ]] \
    || die "unexpected dispatcher verification namespace"
  [[ "$AGENT_TEMPLATE" == echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6 ]] \
    || die "unexpected template name"
  [[ "$NODE_VERSION" == 24.19.0 ]] || die "unexpected Node version"
  [[ "$PI_VERSION" == 0.83.0 ]] || die "unexpected Pi version"
  [[ "$PI_ARCHIVE" == "pi-coding-agent-$PI_VERSION.tgz" ]] \
    || die "unexpected Pi archive name"
  require_file "$BUNDLE_DIR/package-lock.json"
  package_version=$(jq -r '.packages["node_modules/@earendil-works/pi-coding-agent"].version' \
    "$BUNDLE_DIR/package-lock.json")
  lock_integrity=$(jq -r '.packages["node_modules/@earendil-works/pi-coding-agent"].integrity' \
    "$BUNDLE_DIR/package-lock.json")
  [[ "$package_version" == "$PI_VERSION" ]] || die "package-lock Pi version mismatch"
  [[ "$lock_integrity" == "$PI_TARBALL_INTEGRITY" ]] || die "package-lock Pi integrity mismatch"
}

require_dangerous_acknowledgement() {
  [[ ${1:-} == true ]] \
    || die "pass --dangerously-acknowledge through the just recipe"
}

make_remote_stage() {
  local target_host=$1
  local connection_mode=${2:-admin}
  local remote_root

  remote_root=$(ssh_target "$connection_mode" "$target_host" \
    mktemp -d /tmp/echo-ai-agent-deploy.XXXXXX)
  [[ "$remote_root" =~ ^/tmp/echo-ai-agent-deploy\.[A-Za-z0-9]+$ ]] \
    || die "target returned an unsafe staging directory"
  tar \
    --exclude='./node_modules' \
    --exclude='*/__pycache__' \
    --exclude='*.pyc' \
    -C "$BUNDLE_DIR" -cf - . \
    | ssh_target "$connection_mode" "$target_host" tar -C "$remote_root" -xf -
  printf '%s\n' "$remote_root"
}

remove_remote_stage() {
  local target_host=$1
  local remote_root=$2
  local connection_mode=${3:-admin}

  [[ "$remote_root" =~ ^/tmp/echo-ai-agent-deploy\.[A-Za-z0-9]+$ ]] || return 0
  ssh_target "$connection_mode" "$target_host" \
    rm -rf -- "$remote_root" >/dev/null 2>&1 || true
}
