#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

BUNDLE_DIR=${1:?bundle directory is required}
dangerously_acknowledge=${2:-}
[[ "$BUNDLE_DIR" =~ ^/tmp/echo-ai-agent-deploy\.[A-Za-z0-9]+$ ]] || {
  printf '[echo-ai-agent] ERROR: unsafe bundle directory\n' >&2
  exit 1
}
# shellcheck disable=SC1091
source "$BUNDLE_DIR/config/host.env"
# shellcheck disable=SC1091
source "$BUNDLE_DIR/versions.env"

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
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

[[ $EUID -eq 0 ]] || die "setup-host.sh must run as root"
[[ $(hostname) == "$EXPECTED_HOSTNAME" ]] || die "unexpected host"
[[ "$dangerously_acknowledge" == true ]] \
  || die "missing dangerous-operation acknowledgement"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes \
  "incus=$INCUS_DEBIAN_VERSION" \
  ca-certificates \
  curl \
  jq \
  lvm2 \
  nftables \
  openssl \
  openssh-server \
  python3 \
  thin-provisioning-tools \
  xz-utils

migrate_admin_ssh_port() {
  local backup=/etc/ssh/sshd_config.echo-ai-agent-before-port-migration
  local config=/etc/ssh/sshd_config
  local port_count

  if ss -H -ltn "sport = :22" | grep -q .; then
    ss -H -ltnp "sport = :22" | grep -Fq '"sshd"' \
      || die "port 22 has an unexpected listener"
    sshd -T | awk '$1 == "port" && $2 == 22 { found = 1 } END { exit !found }' \
      || die "port 22 is not owned by the main SSH configuration"
    return
  fi
  sshd -T | awk '$1 == "port" && $2 == 22031 { found = 1 } END { exit !found }' \
    || die "main SSH is not in the expected port-22031 bootstrap state"
  port_count=$(grep -Ec '^[[:space:]]*Port[[:space:]]+22031[[:space:]]*$' "$config")
  [[ "$port_count" -eq 1 ]] || die "expected exactly one Port 22031 line in $config"
  [[ ! -e "$backup" ]] || die "SSH migration backup already exists unexpectedly"
  cp --preserve=all "$config" "$backup"
  sed -i -E 's/^[[:space:]]*Port[[:space:]]+22031[[:space:]]*$/Port 22/' "$config"
  sshd -t
  systemctl reload ssh.service
  for _ in $(seq 1 20); do
    ss -H -ltn "sport = :22" | grep -q . && break
    sleep 0.25
  done
  ss -H -ltn "sport = :22" | grep -q . || die "main SSH did not bind port 22"
  ss -H -ltnp "sport = :22" | grep -Fq '"sshd"' \
    || die "main SSH does not own port 22"
  sshd -T | awk '$1 == "port" && $2 == 22 { found = 1 } END { exit !found }' \
    || die "main SSH effective port is not 22"
}

verify_audited_root_partition() {
  local partition
  local root_source
  local unexpected_partition

  [[ $(lsblk -dnro PTTYPE "$STORAGE_DISK") == "$EXPECTED_PARTITION_TABLE" ]] \
    || die "$STORAGE_DISK must use $EXPECTED_PARTITION_TABLE"
  [[ $(lsblk -dnro LOG-SEC "$STORAGE_DISK") == "$STORAGE_LOGICAL_SECTOR_BYTES" ]] \
    || die "$STORAGE_DISK logical sector size differs from the audited host"
  [[ -b "$STORAGE_ROOT_PARTITION" ]] || die "$STORAGE_ROOT_PARTITION is missing"
  [[ $(lsblk -bnro START "$STORAGE_ROOT_PARTITION") == "$STORAGE_ROOT_START_SECTOR" ]] \
    || die "$STORAGE_ROOT_PARTITION start differs from the audited host"
  [[ $(partition_sectors "$STORAGE_ROOT_PARTITION") == "$STORAGE_ROOT_SECTORS" ]] \
    || die "$STORAGE_ROOT_PARTITION size differs from the audited host"
  [[ $(lsblk -dnro FSTYPE "$STORAGE_ROOT_PARTITION") == "$STORAGE_ROOT_FSTYPE" ]] \
    || die "$STORAGE_ROOT_PARTITION filesystem differs from the audited host"
  root_source=$(findmnt -rn -M "$STORAGE_ROOT_MOUNTPOINT" -o SOURCE)
  [[ -n "$root_source" ]] \
    || die "nothing is mounted at $STORAGE_ROOT_MOUNTPOINT"
  [[ $(readlink -f -- "$root_source") == $(readlink -f -- "$STORAGE_ROOT_PARTITION") ]] \
    || die "$STORAGE_ROOT_PARTITION is not mounted at $STORAGE_ROOT_MOUNTPOINT"
  unexpected_partition=$(sfdisk --json "$STORAGE_DISK" \
    | jq -r --arg root "$STORAGE_ROOT_PARTITION" --arg storage "$STORAGE_PARTITION" \
      '.partitiontable.partitions[]?.node | select(. != $root and . != $storage)' \
    | head -n 1)
  [[ -z "$unexpected_partition" ]] \
    || die "unexpected partition on $STORAGE_DISK: $unexpected_partition"
  partition=$(sfdisk --json "$STORAGE_DISK" \
    | jq -r --arg root "$STORAGE_ROOT_PARTITION" \
      '[.partitiontable.partitions[]? | select(.node == $root)] | length')
  [[ "$partition" == 1 ]] || die "expected exactly one audited root partition"
}

storage_partition_record() {
  sfdisk --json "$STORAGE_DISK" \
    | jq -r --arg storage "$STORAGE_PARTITION" \
      -f "$BUNDLE_DIR/config/storage-partition-record.jq"
}

verify_storage_partition_record() {
  local actual_size actual_start actual_type
  local record=$1

  IFS=$'\t' read -r actual_start actual_size actual_type <<<"$record"
  [[ "$actual_start" == "$free_start" ]] \
    || die "$STORAGE_PARTITION has unexpected table start $actual_start"
  [[ "$actual_size" == "$partition_sectors" ]] \
    || die "$STORAGE_PARTITION has unexpected table size $actual_size"
  [[ "$actual_type" == 8e ]] \
    || die "$STORAGE_PARTITION has unexpected table type $actual_type"
}

verify_partition_backup() {
  [[ -s "$STORAGE_PARTITION_TABLE_BACKUP" ]] \
    || die "partition table backup is missing"
  [[ $(stat -c '%U:%G' "$STORAGE_PARTITION_TABLE_BACKUP") == root:root ]] \
    || die "partition table backup is not root-owned"
  [[ $(stat -c '%a' "$STORAGE_PARTITION_TABLE_BACKUP") == 600 ]] \
    || die "partition table backup must have mode 0600"
  grep -Fq "sector-size: $STORAGE_LOGICAL_SECTOR_BYTES" \
    "$STORAGE_PARTITION_TABLE_BACKUP" \
    || die "partition table backup has an unexpected sector size"
  grep -Fq "$STORAGE_ROOT_PARTITION" "$STORAGE_PARTITION_TABLE_BACKUP" \
    || die "partition table backup does not contain the audited root partition"
  ! grep -Fq "$STORAGE_PARTITION" "$STORAGE_PARTITION_TABLE_BACKUP" \
    || die "partition table backup already contains $STORAGE_PARTITION"
}

write_or_verify_storage_marker() {
  local marker_partition marker_sectors marker_start

  install -d -m 0700 "$(dirname "$STORAGE_MARKER")"
  if [[ -f "$STORAGE_MARKER" ]]; then
    # shellcheck disable=SC1090
    source "$STORAGE_MARKER"
    marker_partition=${partition:-}
    marker_start=${start:-}
    marker_sectors=${sectors:-}
    [[ "$marker_partition" == "$STORAGE_PARTITION" \
      && "$marker_start" == "$p2_start" \
      && "$marker_sectors" == "$p2_sectors" ]] \
      || die "storage ownership marker does not match $STORAGE_PARTITION"
    return
  fi
  verify_partition_backup
  {
    printf 'partition=%q\n' "$STORAGE_PARTITION"
    printf 'start=%q\n' "$p2_start"
    printf 'sectors=%q\n' "$p2_sectors"
  } >"$STORAGE_MARKER"
  chmod 0600 "$STORAGE_MARKER"
}

verify_audited_root_partition
migrate_admin_ssh_port
p1_start=$(lsblk -bnro START "$STORAGE_ROOT_PARTITION")
p1_sectors=$(partition_sectors "$STORAGE_ROOT_PARTITION")
p1_type=$(lsblk -dnro PARTTYPE "$STORAGE_ROOT_PARTITION")
disk_sectors=$(blockdev --getsz "$STORAGE_DISK")
free_start=$((((p1_start + p1_sectors + 2047) / 2048) * 2048))
free_end=$((disk_sectors - 1))
partition_sectors=$((free_end - free_start + 1))
storage_record=$(storage_partition_record)
if [[ -z "$storage_record" ]]; then
  install -d -m 0700 "$(dirname "$STORAGE_PARTITION_TABLE_BACKUP")"
  table_backup="${STORAGE_PARTITION_TABLE_BACKUP}.new.$$"
  umask 077
  sfdisk --dump "$STORAGE_DISK" >"$table_backup"
  [[ -s "$table_backup" ]] || die "partition table backup is empty"
  if [[ -e "$STORAGE_PARTITION_TABLE_BACKUP" ]]; then
    cmp -s "$table_backup" "$STORAGE_PARTITION_TABLE_BACKUP" \
      || die "existing partition table backup does not match current table"
    rm -f -- "$table_backup"
  else
    mv "$table_backup" "$STORAGE_PARTITION_TABLE_BACKUP"
    chmod 0600 "$STORAGE_PARTITION_TABLE_BACKUP"
  fi
  printf 'start=%s, size=%s, type=8e\n' "$free_start" "$partition_sectors" \
    | sfdisk --append --no-reread --no-tell-kernel "$STORAGE_DISK"
  storage_record=$(storage_partition_record)
  [[ -n "$storage_record" ]] || die "$STORAGE_PARTITION was not written to the table"
fi
verify_storage_partition_record "$storage_record"
verify_partition_backup
if [[ ! -b "$STORAGE_PARTITION" ]]; then
  partx --add --nr "$STORAGE_PARTITION_NUMBER:$STORAGE_PARTITION_NUMBER" \
    "$STORAGE_DISK"
  udevadm settle
fi

[[ -b "$STORAGE_PARTITION" ]] || die "$STORAGE_PARTITION was not created"
[[ $(lsblk -dnro PTTYPE "$STORAGE_DISK") == "$EXPECTED_PARTITION_TABLE" ]] \
  || die "partition table type changed"
[[ $(lsblk -bnro START "$STORAGE_ROOT_PARTITION") == "$p1_start" ]] \
  || die "$STORAGE_ROOT_PARTITION start changed"
[[ $(partition_sectors "$STORAGE_ROOT_PARTITION") == "$p1_sectors" ]] \
  || die "$STORAGE_ROOT_PARTITION size changed"
[[ $(lsblk -dnro PARTTYPE "$STORAGE_ROOT_PARTITION") == "$p1_type" ]] \
  || die "$STORAGE_ROOT_PARTITION type changed"
[[ $(lsblk -dnro PARTTYPE "$STORAGE_PARTITION") == 0x8e ]] \
  || die "$STORAGE_PARTITION does not have MBR type 0x8e"
p1_end=$((p1_start + p1_sectors - 1))
p2_start=$(lsblk -bnro START "$STORAGE_PARTITION")
((p2_start > p1_end)) || die "$STORAGE_PARTITION overlaps $STORAGE_ROOT_PARTITION"
p2_sectors=$(partition_sectors "$STORAGE_PARTITION")
[[ "$p2_start" == "$free_start" && "$p2_sectors" == "$partition_sectors" ]] \
  || die "$STORAGE_PARTITION kernel geometry differs from the partition table"
write_or_verify_storage_marker
printf '[echo-ai-agent] host prerequisites are installed\n'
