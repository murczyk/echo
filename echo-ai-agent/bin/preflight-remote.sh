#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

EXPECTED_HOSTNAME=${1:?expected hostname is required}
EXPECTED_OS_ID=${2:?expected OS ID is required}
EXPECTED_OS_VERSION_ID=${3:?expected OS version is required}
EXPECTED_ARCH=${4:?expected architecture is required}
EXPECTED_PARTITION_TABLE=${5:?partition table is required}
STORAGE_DISK=${6:?storage disk is required}
STORAGE_PARTITION=${7:?storage partition is required}
STORAGE_MARKER=${8:?storage marker is required}
STORAGE_ROOT_PARTITION=${9:?root partition is required}
STORAGE_LOGICAL_SECTOR_BYTES=${10:?logical sector size is required}
STORAGE_ROOT_START_SECTOR=${11:?root partition start is required}
STORAGE_ROOT_SECTORS=${12:?root partition size is required}
STORAGE_ROOT_FSTYPE=${13:?root filesystem is required}
STORAGE_ROOT_MOUNTPOINT=${14:?root mountpoint is required}
STORAGE_MIN_FREE_BYTES=${15:?minimum free bytes is required}
DISPATCH_PORT=${16:?dispatcher port is required}
STORAGE_POOL=${17:?storage pool is required}
STORAGE_VG=${18:?storage VG is required}
STORAGE_THINPOOL=${19:?storage thin pool is required}

die() {
  printf '[echo-ai-agent] PREFLIGHT ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

verify_identity() {
  [[ $(hostname) == "$EXPECTED_HOSTNAME" ]] \
    || die "expected hostname $EXPECTED_HOSTNAME, found $(hostname)"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "$ID" == "$EXPECTED_OS_ID" && "$VERSION_ID" == "$EXPECTED_OS_VERSION_ID" ]] \
    || die "expected $EXPECTED_OS_ID $EXPECTED_OS_VERSION_ID, found $ID $VERSION_ID"
  [[ $(dpkg --print-architecture) == "$EXPECTED_ARCH" ]] \
    || die "expected architecture $EXPECTED_ARCH"
  sudo -n true || die "passwordless sudo is required"
}

partition_names() {
  lsblk -lnpo NAME,TYPE "$STORAGE_DISK" | awk '$2 == "part" { print $1 }'
}

partition_sectors() {
  local partition=$1
  local size_bytes

  size_bytes=$(lsblk -bdnro SIZE "$partition")
  [[ "$size_bytes" =~ ^[0-9]+$ ]] || die "invalid size for $partition"
  ((size_bytes % STORAGE_LOGICAL_SECTOR_BYTES == 0)) \
    || die "$partition size is not sector-aligned"
  printf '%s\n' "$((size_bytes / STORAGE_LOGICAL_SECTOR_BYTES))"
}

verify_storage_marker() {
  local expected
  local marker
  local marker_mode
  local marker_owner
  local p2_sectors=$1
  local p2_start=$2

  [[ "$STORAGE_MARKER" == /var/lib/echo-ai-agent/storage-partition-created ]] \
    || die "unexpected storage marker path"
  sudo -n test -f "$STORAGE_MARKER" || die "storage ownership marker is missing"
  sudo -n test ! -L "$STORAGE_MARKER" || die "storage ownership marker is a symlink"
  marker_owner=$(sudo -n stat -c '%U:%G' "$STORAGE_MARKER")
  [[ "$marker_owner" == root:root ]] \
    || die "storage ownership marker is not root-owned"
  marker_mode=$(sudo -n stat -c '%a' "$STORAGE_MARKER")
  [[ "$marker_mode" == 600 ]] || die "storage ownership marker must have mode 0600"
  marker=$(sudo -n cat -- "$STORAGE_MARKER")
  printf -v expected 'partition=%q\nstart=%q\nsectors=%q' \
    "$STORAGE_PARTITION" "$p2_start" "$p2_sectors"
  [[ "$marker" == "$expected" ]] \
    || die "storage ownership marker does not match live partition geometry"
}

verify_managed_storage_pool() {
  local driver

  driver=$(incus storage show "$STORAGE_POOL" | awk '$1 == "driver:" { print $2 }')
  [[ "$driver" == lvm ]] || die "$STORAGE_POOL is not an LVM pool"
  [[ $(incus storage get "$STORAGE_POOL" source) == "$STORAGE_POOL" ]] \
    || die "$STORAGE_POOL has an unexpected normalized source"
  [[ $(incus storage get "$STORAGE_POOL" volatile.initial_source) == "$STORAGE_PARTITION" ]] \
    || die "$STORAGE_POOL was not initialized from $STORAGE_PARTITION"
  [[ $(incus storage get "$STORAGE_POOL" lvm.vg_name) == "$STORAGE_VG" ]] \
    || die "$STORAGE_POOL uses an unexpected VG"
  [[ $(incus storage get "$STORAGE_POOL" lvm.thinpool_name) == "$STORAGE_THINPOOL" ]] \
    || die "$STORAGE_POOL uses an unexpected thin pool"
  [[ $(incus storage get "$STORAGE_POOL" lvm.use_thinpool) == true ]] \
    || die "$STORAGE_POOL is not thin-provisioned"
}

verify_storage() {
  local disk_sector_size
  local disk_sectors
  local free_bytes
  local free_end
  local free_start
  local p1_end
  local p1_fstype
  local p1_sectors
  local p1_start
  local partition
  local root_source

  [[ -b "$STORAGE_DISK" ]] || die "$STORAGE_DISK is not a block device"
  [[ $(lsblk -dnro PTTYPE "$STORAGE_DISK") == "$EXPECTED_PARTITION_TABLE" ]] \
    || die "$STORAGE_DISK must use $EXPECTED_PARTITION_TABLE"
  [[ $(lsblk -dnro LOG-SEC "$STORAGE_DISK") == "$STORAGE_LOGICAL_SECTOR_BYTES" ]] \
    || die "$STORAGE_DISK logical sector size differs from the audited host"
  [[ -b "$STORAGE_ROOT_PARTITION" ]] || die "$STORAGE_ROOT_PARTITION is missing"
  while IFS= read -r partition; do
    [[ "$partition" == "$STORAGE_ROOT_PARTITION" || "$partition" == "$STORAGE_PARTITION" ]] \
      || die "unexpected partition on storage disk: $partition"
  done < <(partition_names)

  p1_start=$(lsblk -bnro START "$STORAGE_ROOT_PARTITION")
  p1_sectors=$(partition_sectors "$STORAGE_ROOT_PARTITION")
  p1_fstype=$(lsblk -dnro FSTYPE "$STORAGE_ROOT_PARTITION")
  [[ "$p1_start" == "$STORAGE_ROOT_START_SECTOR" ]] \
    || die "$STORAGE_ROOT_PARTITION has unexpected start sector $p1_start"
  [[ "$p1_sectors" == "$STORAGE_ROOT_SECTORS" ]] \
    || die "$STORAGE_ROOT_PARTITION has unexpected sector count $p1_sectors"
  [[ "$p1_fstype" == "$STORAGE_ROOT_FSTYPE" ]] \
    || die "$STORAGE_ROOT_PARTITION has unexpected filesystem $p1_fstype"
  root_source=$(findmnt -rn -M "$STORAGE_ROOT_MOUNTPOINT" -o SOURCE)
  [[ -n "$root_source" ]] \
    || die "nothing is mounted at $STORAGE_ROOT_MOUNTPOINT"
  [[ $(readlink -f -- "$root_source") == $(readlink -f -- "$STORAGE_ROOT_PARTITION") ]] \
    || die "$STORAGE_ROOT_PARTITION is not mounted at $STORAGE_ROOT_MOUNTPOINT"
  disk_sectors=$(sudo -n blockdev --getsz "$STORAGE_DISK")
  disk_sector_size=$(sudo -n blockdev --getss "$STORAGE_DISK")
  [[ "$disk_sector_size" == "$STORAGE_LOGICAL_SECTOR_BYTES" ]] \
    || die "$STORAGE_DISK block sector size differs from the audited host"
  p1_end=$((p1_start + p1_sectors - 1))
  free_start=$((((p1_end + 1 + 2047) / 2048) * 2048))
  free_end=$((disk_sectors - 1))

  if [[ -b "$STORAGE_PARTITION" ]]; then
    local filesystem incus_managed mounted p2_sectors p2_start pv_name
    p2_start=$(lsblk -bnro START "$STORAGE_PARTITION")
    p2_sectors=$(partition_sectors "$STORAGE_PARTITION")
    verify_storage_marker "$p2_sectors" "$p2_start"
    [[ $(lsblk -dnro PARTTYPE "$STORAGE_PARTITION") == 0x8e ]] \
      || die "$STORAGE_PARTITION must have MBR type 0x8e"
    ((p2_start > p1_end)) || die "$STORAGE_PARTITION overlaps $STORAGE_ROOT_PARTITION"
    free_bytes=$((p2_sectors * disk_sector_size))
    incus_managed=false
    if command -v incus >/dev/null 2>&1 \
      && incus storage show "$STORAGE_POOL" >/dev/null 2>&1; then
      verify_managed_storage_pool
      incus_managed=true
    fi
    if [[ "$incus_managed" != true ]]; then
      mounted=$(findmnt -rn -S "$STORAGE_PARTITION" || true)
      filesystem=$(lsblk -dnro FSTYPE "$STORAGE_PARTITION")
      pv_name=
      if command -v pvs >/dev/null 2>&1; then
        pv_name=$(sudo -n pvs --noheadings -o pv_name "$STORAGE_PARTITION" 2>/dev/null \
          | xargs || true)
      fi
      [[ -z "$mounted" ]] || die "$STORAGE_PARTITION is mounted"
      [[ -z "$filesystem" ]] || die "$STORAGE_PARTITION has signature $filesystem"
      [[ -z "$pv_name" ]] || die "$STORAGE_PARTITION is already an unmanaged LVM PV"
    fi
  else
    ((free_end > free_start)) \
      || die "no usable unallocated region follows $STORAGE_ROOT_PARTITION"
    free_bytes=$(((free_end - free_start + 1) * disk_sector_size))
  fi
  ((free_bytes >= STORAGE_MIN_FREE_BYTES)) \
    || die "storage region is smaller than $STORAGE_MIN_FREE_BYTES bytes"
  printf '[echo-ai-agent] storage_region_bytes=%s partition_present=%s\n' \
    "$free_bytes" "$([[ -b "$STORAGE_PARTITION" ]] && printf true || printf false)"
}

verify_port() {
  local listener
  listener=$(sudo -n ss -H -ltnp "sport = :$DISPATCH_PORT" || true)
  if [[ -n "$listener" ]]; then
    if sudo -n systemctl is-active --quiet echo-ai-agent-sshd.service; then
      printf '[echo-ai-agent] dispatcher_listener=active\n'
    elif sudo -n systemctl is-active --quiet ssh.service \
      && grep -Fq '"sshd"' <<<"$listener" \
      && sudo -n sshd -T | awk -v port="$DISPATCH_PORT" \
        '$1 == "port" && $2 == port { found = 1 } END { exit !found }'; then
      printf '[echo-ai-agent] admin_ssh_port_migration=pending\n'
    else
      die "port $DISPATCH_PORT has an unexpected owner"
    fi
  fi
}

for command in awk blockdev dpkg findmnt hostname lsblk readlink ss sudo; do
  require_cmd "$command"
done
verify_identity
verify_storage
verify_port
if command -v tailscale >/dev/null 2>&1; then
  tailscale ip -4 | head -n 1 | sed 's/^/[echo-ai-agent] tailscale_ipv4=/'
else
  die "Tailscale is required"
fi
printf '[echo-ai-agent] preflight passed\n'
