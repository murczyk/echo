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

INSTALL_ROOT=/opt/echo-ai-agent
CONFIG_ROOT=/etc/echo-ai-agent
RELEASE_DIR="$INSTALL_ROOT/releases/$HARNESS_RELEASE"

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

tree_digest() {
  local directory=$1
  (
    cd "$directory"
    find . \
      -type f \
      ! -path './node_modules/*' \
      ! -path '*/__pycache__/*' \
      ! -name '*.pyc' \
      -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
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

verify_protected_file() {
  local mode
  local path=$1
  local resolved

  resolved=$(readlink -f -- "$path")
  [[ -f "$resolved" ]] || die "protected file is missing: $path"
  [[ $(stat -c '%U:%G' "$resolved") == root:root ]] \
    || die "protected file is not root-owned: $resolved"
  mode=$(stat -c '%a' "$resolved")
  (((8#$mode & 8#022) == 0)) \
    || die "protected file is group/other writable: $resolved"
}

verify_release_permissions() {
  local unsafe

  unsafe=$(find "$RELEASE_DIR" \
    \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) \
    -print -quit)
  [[ -z "$unsafe" ]] || die "release contains unsafe ownership or mode: $unsafe"
}

verify_lvm_layout() {
  pvs --reportformat json -o pv_name,vg_name 9>&- \
    | jq -e --arg pv "$STORAGE_PARTITION" --arg vg "$STORAGE_VG" \
      -f "$BUNDLE_DIR/config/lvm-pv-layout.jq" >/dev/null \
    || die "$STORAGE_PARTITION is not the sole PV of $STORAGE_VG"
  vgs --reportformat json -o vg_name,pv_count,lv_count 9>&- \
    | jq -e --arg vg "$STORAGE_VG" \
      -f "$BUNDLE_DIR/config/lvm-vg-layout.jq" >/dev/null \
    || die "$STORAGE_VG does not have the expected single-PV layout"
  lvs --reportformat json -o vg_name,lv_name,segtype 9>&- \
    | jq -e --arg vg "$STORAGE_VG" --arg thinpool "$STORAGE_THINPOOL" \
      -f "$BUNDLE_DIR/config/lvm-thinpool-layout.jq" >/dev/null \
    || die "$STORAGE_VG contains an unexpected logical volume"
}

verify_storage_pool() {
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
  verify_lvm_layout
}

ensure_storage() {
  if incus storage show "$STORAGE_POOL" >/dev/null 2>&1; then
    verify_storage_pool
    return
  fi
  verify_fresh_partition
  incus storage create "$STORAGE_POOL" lvm \
    source="$STORAGE_PARTITION" \
    lvm.thinpool_name="$STORAGE_THINPOOL" \
    lvm.use_thinpool=true
  verify_storage_pool
}

verify_fresh_partition() {
  local filesystem marker_partition marker_sectors marker_start mounted p2_sectors p2_start pv_name

  [[ $(lsblk -dnro LOG-SEC "$STORAGE_DISK") == "$STORAGE_LOGICAL_SECTOR_BYTES" ]] \
    || die "$STORAGE_DISK logical sector size differs from the audited host"
  [[ -f "$STORAGE_MARKER" ]] || die "storage ownership marker is missing"
  # shellcheck disable=SC1090
  source "$STORAGE_MARKER"
  marker_partition=${partition:-}
  marker_start=${start:-}
  marker_sectors=${sectors:-}
  [[ "$marker_partition" == "$STORAGE_PARTITION" ]] || die "storage marker partition mismatch"
  [[ "$marker_start" =~ ^[0-9]+$ && "$marker_sectors" =~ ^[0-9]+$ ]] \
    || die "invalid storage marker"
  p2_start=$(lsblk -bnro START "$STORAGE_PARTITION")
  p2_sectors=$(partition_sectors "$STORAGE_PARTITION")
  [[ "$p2_start" == "$marker_start" && "$p2_sectors" == "$marker_sectors" ]] \
    || die "storage partition changed after setup"
  mounted=$(findmnt -rn -S "$STORAGE_PARTITION" || true)
  filesystem=$(lsblk -dnro FSTYPE "$STORAGE_PARTITION")
  pv_name=$(pvs --noheadings -o pv_name "$STORAGE_PARTITION" 2>/dev/null | xargs || true)
  [[ -z "$mounted" ]] || die "$STORAGE_PARTITION is mounted"
  [[ -z "$filesystem" ]] || die "$STORAGE_PARTITION has signature $filesystem"
  [[ -z "$pv_name" ]] || die "$STORAGE_PARTITION is already an unmanaged LVM PV"
  [[ -z $(wipefs --no-act "$STORAGE_PARTITION") ]] \
    || die "$STORAGE_PARTITION contains an unexpected signature"
}

ensure_network() {
  local address ipv6

  if incus network show "$AGENT_BRIDGE" >/dev/null 2>&1; then
    address=$(incus network get "$AGENT_BRIDGE" ipv4.address)
    ipv6=$(incus network get "$AGENT_BRIDGE" ipv6.address)
    [[ "$address" == "$AGENT_BRIDGE_IPV4" ]] \
      || die "$AGENT_BRIDGE has unexpected IPv4 address $address"
    [[ "$ipv6" == none ]] || die "$AGENT_BRIDGE must have IPv6 disabled"
    return
  fi
  incus network create "$AGENT_BRIDGE" \
    ipv4.address="$AGENT_BRIDGE_IPV4" \
    ipv4.nat=true \
    ipv6.address=none
}

ensure_profile_device() {
  local device=$1
  local type=$2
  shift 2

  if incus profile device get "$AGENT_PROFILE" "$device" type >/dev/null 2>&1; then
    [[ $(incus profile device get "$AGENT_PROFILE" "$device" type) == "$type" ]] \
      || die "$AGENT_PROFILE/$device has an unexpected device type"
    incus profile device set "$AGENT_PROFILE" "$device" "$@"
    return
  fi
  incus profile device add "$AGENT_PROFILE" "$device" "$type" "$@"
}

require_instance_config_key() {
  local key=$1

  incus query /1.0/metadata/configuration \
    | jq -e --arg key "$key" -f "$BUNDLE_DIR/config/incus-instance-key.jq" \
      >/dev/null \
    || die "installed Incus does not support required key $key"
}

require_nic_config_key() {
  local key=$1

  incus query /1.0/metadata/configuration \
    | jq -e --arg key "$key" -f "$BUNDLE_DIR/config/incus-nic-key.jq" \
      >/dev/null \
    || die "installed Incus does not support required NIC key $key"
}

ensure_profile() {
  require_instance_config_key security.guestapi
  require_instance_config_key security.guestapi.images
  require_nic_config_key security.ipv4_filtering
  require_nic_config_key security.mac_filtering
  require_nic_config_key security.port_isolation
  incus profile show "$AGENT_PROFILE" >/dev/null 2>&1 \
    || incus profile create "$AGENT_PROFILE"
  incus profile set "$AGENT_PROFILE" \
    boot.autostart=false \
    limits.cpu="$AGENT_CPU_LIMIT" \
    limits.memory="$AGENT_MEMORY_LIMIT" \
    limits.processes="$AGENT_PROCESS_LIMIT" \
    security.guestapi=false \
    security.guestapi.images=false \
    security.nesting=false \
    security.privileged=false \
    security.protection.shift=true \
    raw.lxc="lxc.sysctl.net.ipv6.conf.all.disable_ipv6=1
lxc.sysctl.net.ipv6.conf.default.disable_ipv6=1"
  ensure_profile_device root disk pool="$STORAGE_POOL" path=/ size="$AGENT_ROOT_SIZE"
  ensure_profile_device eth0 nic \
    network="$AGENT_BRIDGE" \
    name=eth0 \
    security.ipv4_filtering=true \
    security.mac_filtering=true \
    security.port_isolation=true
  unexpected_devices=$(incus query "/1.0/profiles/$AGENT_PROFILE" \
    | jq -r '.devices | keys[] | select(. != "root" and . != "eth0")')
  [[ -z "$unexpected_devices" ]] \
    || die "$AGENT_PROFILE has unexpected devices: $unexpected_devices"
}

install_release() {
  local current_target=
  local incoming_digest
  local installed_digest
  local next_link="$INSTALL_ROOT/.current.$$"

  install -d -m 0755 "$INSTALL_ROOT/releases"
  incoming_digest=$(tree_digest "$BUNDLE_DIR")
  if [[ -d "$RELEASE_DIR" ]]; then
    installed_digest=$(tree_digest "$RELEASE_DIR")
    [[ "$incoming_digest" == "$installed_digest" ]] \
      || die "release $HARNESS_RELEASE exists with different content; bump HARNESS_RELEASE"
  else
    cp -a "$BUNDLE_DIR" "$RELEASE_DIR"
  fi
  chown -R root:root "$RELEASE_DIR"
  chmod -R go-w "$RELEASE_DIR"
  verify_release_permissions
  if [[ -L "$INSTALL_ROOT/current" ]]; then
    current_target=$(readlink "$INSTALL_ROOT/current")
  elif [[ -e "$INSTALL_ROOT/current" ]]; then
    die "$INSTALL_ROOT/current is not a symbolic link"
  fi
  if [[ -n "$current_target" && "$current_target" != "releases/$HARNESS_RELEASE" ]]; then
    ln -sfn "$current_target" "$INSTALL_ROOT/previous"
  fi
  ln -s "releases/$HARNESS_RELEASE" "$next_link"
  mv -Tf "$next_link" "$INSTALL_ROOT/current"
}

install_dispatcher() {
  local legacy_key

  getent group "$DISPATCH_GROUP" >/dev/null \
    || groupadd --system "$DISPATCH_GROUP"
  install -d -o root -g root -m 0755 \
    "$CONFIG_ROOT" \
    "$CONFIG_ROOT/authorized_keys" \
    "$DISPATCH_NAMESPACE_DIR" \
    /usr/local/libexec
  if [[ ! -f "$CONFIG_ROOT/ssh_host_ed25519_key" ]]; then
    ssh-keygen -q -t ed25519 -N '' -f "$CONFIG_ROOT/ssh_host_ed25519_key"
  fi
  chmod 0600 "$CONFIG_ROOT/ssh_host_ed25519_key"
  chmod 0644 "$CONFIG_ROOT/ssh_host_ed25519_key.pub"

  install -m 0644 "$BUNDLE_DIR/config/sshd_config" "$CONFIG_ROOT/sshd_config"
  ln -sfn "$INSTALL_ROOT/current/dispatcher/echo_ai_agent_dispatcher.py" \
    /usr/local/libexec/echo-ai-agent-dispatch
  ln -sfn "$INSTALL_ROOT/current/bin/force-command.sh" \
    /usr/local/libexec/echo-ai-agent-force-command
  ln -sfn "$INSTALL_ROOT/current/bin/prepare-dispatcher-homes.sh" \
    /usr/local/libexec/echo-ai-agent-prepare-dispatcher-homes

  legacy_key="$CONFIG_ROOT/authorized_keys/$DISPATCH_LEGACY_USER"
  if id "$DISPATCH_LEGACY_USER" >/dev/null 2>&1 || [[ -e "$legacy_key" ]]; then
    "$BUNDLE_DIR/bin/reconcile-dispatcher-identity.sh" \
      "$DISPATCH_LEGACY_NAMESPACE" >/dev/null
  fi
}

install_firewall() {
  install -d -m 0755 /usr/local/libexec
  install -m 0644 "$BUNDLE_DIR/config/echo-ai-agent.nft" \
    "$CONFIG_ROOT/echo-ai-agent.nft"
  ln -sfn "$INSTALL_ROOT/current/bin/apply-firewall.sh" \
    /usr/local/libexec/echo-ai-agent-apply-firewall
}

install_units() {
  systemd-analyze verify \
    "$BUNDLE_DIR/systemd/echo-ai-agent-firewall.service" \
    "$BUNDLE_DIR/systemd/echo-ai-agent-sshd.service"
  install -m 0644 "$BUNDLE_DIR/systemd/echo-ai-agent-firewall.service" \
    /etc/systemd/system/echo-ai-agent-firewall.service
  install -m 0644 "$BUNDLE_DIR/systemd/echo-ai-agent-sshd.service" \
    /etc/systemd/system/echo-ai-agent-sshd.service
  systemctl daemon-reload
  systemctl enable --now echo-ai-agent-firewall.service echo-ai-agent-sshd.service
  systemctl reload-or-restart echo-ai-agent-firewall.service
  systemctl restart echo-ai-agent-sshd.service
}

verify_runtime_permissions() {
  verify_release_permissions
  verify_protected_file /usr/local/libexec/echo-ai-agent-dispatch
  verify_protected_file /usr/local/libexec/echo-ai-agent-force-command
  verify_protected_file /usr/local/libexec/echo-ai-agent-prepare-dispatcher-homes
  verify_protected_file /usr/local/libexec/echo-ai-agent-apply-firewall
  verify_protected_file "$CONFIG_ROOT/sshd_config"
  verify_protected_file "$CONFIG_ROOT/echo-ai-agent.nft"
}

[[ $EUID -eq 0 ]] || die "install-host.sh must run as root"
[[ $(hostname) == "$EXPECTED_HOSTNAME" ]] || die "unexpected host"
[[ "$dangerously_acknowledge" == true ]] \
  || die "missing dangerous-operation acknowledgement"
[[ -b "$STORAGE_PARTITION" ]] || die "$STORAGE_PARTITION is missing; run setup"
[[ $(dpkg-query -W -f='${Version}' incus) == "$INCUS_DEBIAN_VERSION" ]] \
  || die "installed Incus version is not pinned"

exec 9>/run/lock/echo-ai-agent-deploy.lock
flock -n 9 || die "another deployment is running"
systemctl enable --now incus.service
incus admin waitready --timeout=60
ensure_storage
ensure_network
ensure_profile
install_release
install_dispatcher
install_firewall
install_units
verify_runtime_permissions
ssh-keygen -lf "$CONFIG_ROOT/ssh_host_ed25519_key.pub"
printf '[echo-ai-agent] host deployment complete; no Echo key was installed automatically\n'
