#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euo pipefail
BUNDLE_DIR=${1:?bundle directory is required}
source "$BUNDLE_DIR/bin/load-host-config.sh"
[[ $(id -u) == 0 && $(hostname) == "$EXPECTED_HOSTNAME" ]] || exit 1
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 && $(dpkg --print-architecture) == amd64 ]] || exit 1
[[ "$STORAGE_LAYOUT" == dedicated-disk && -b "$STORAGE_DISK" ]] || exit 1
[[ $(lsblk -dnro SERIAL "$STORAGE_DISK") == "$STORAGE_DISK_SERIAL" \
  && $(blockdev --getsize64 "$STORAGE_DISK") == "$STORAGE_DISK_BYTES" ]] || exit 1
! lsblk -nrpo TYPE "$STORAGE_DISK" | grep -Fxq part || exit 1
root_source=$(findmnt -rn -M / -o SOURCE)
! lsblk -snrpo NAME "$root_source" | grep -Fxq "$STORAGE_DISK" || exit 1
[[ -z $(findmnt -rn -S "$STORAGE_DISK") ]] || exit 1
expected=$(printf 'partition=%q\nstart=0\nsectors=%q' "$STORAGE_DISK" "$(blockdev --getsz "$STORAGE_DISK")")
if [[ -e "$STORAGE_MARKER" ]]; then
  [[ ! -L "$STORAGE_MARKER" && $(stat -c '%U:%G:%a' "$STORAGE_MARKER") == root:root:600 \
    && $(cat "$STORAGE_MARKER") == "$expected" ]] || exit 1
  if incus storage show "$STORAGE_POOL" >/dev/null 2>&1; then
    [[ $(incus storage get "$STORAGE_POOL" volatile.initial_source) == "$STORAGE_DISK" ]] || exit 1
  else
    [[ -z $(wipefs --no-act "$STORAGE_DISK") ]] || exit 1
  fi
else
  [[ -z $(wipefs --no-act "$STORAGE_DISK") ]] || exit 1
  if [[ ${2:-check} == setup ]]; then
    install -d -m 0700 "$(dirname "$STORAGE_MARKER")"
    (umask 077; printf '%s\n' "$expected" >"$STORAGE_MARKER")
  fi
fi
printf '[echo-ai-agent] dedicated storage identity and ownership verified\n'
