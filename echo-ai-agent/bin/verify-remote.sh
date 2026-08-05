#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

EXPECTED_HOSTNAME=$1
INCUS_DEBIAN_VERSION=$2
STORAGE_POOL=$3
STORAGE_PARTITION=$4
STORAGE_VG=$5
STORAGE_THINPOOL=$6
AGENT_BRIDGE=$7
AGENT_BRIDGE_IPV4=$8
AGENT_PROFILE=$9
AGENT_CPU_LIMIT=${10}
AGENT_MEMORY_LIMIT=${11}
AGENT_PROCESS_LIMIT=${12}
AGENT_ROOT_SIZE=${13}
AGENT_TEMPLATE=${14}
NODE_VERSION=${15}
PI_VERSION=${16}
DISPATCH_PORT=${17}
AGENT_MAX_RUNNING=${18}
HARNESS_RELEASE=${19}
AGENT_CONTAINER_UID=${20}
AGENT_CONTAINER_GID=${21}
DISPATCH_GROUP=${22}
DISPATCH_NAMESPACE_DIR=${23}
DISPATCH_RUNTIME_ROOT=${24}
DISPATCH_LOCK_PATH=${25}

die() {
  printf '[echo-ai-agent] VERIFY ERROR: %s\n' "$*" >&2
  exit 1
}

expect_equal() {
  local label=$1
  local actual=$2
  local expected=$3
  [[ "$actual" == "$expected" ]] || die "$label: expected $expected, found $actual"
}

verify_protected_file() {
  local mode
  local path=$1
  local resolved

  resolved=$(readlink -f -- "$path")
  [[ -f "$resolved" ]] || die "protected file is missing: $path"
  expect_equal "$resolved owner" "$(sudo -n stat -c '%U:%G' "$resolved")" root:root
  mode=$(sudo -n stat -c '%a' "$resolved")
  (((8#$mode & 8#022) == 0)) \
    || die "protected file is group/other writable: $resolved"
}

verify_lvm_layout() {
  sudo -n pvs --reportformat json -o pv_name,vg_name \
    | jq -e --arg pv "$STORAGE_PARTITION" --arg vg "$STORAGE_VG" \
      -f /opt/echo-ai-agent/current/config/lvm-pv-layout.jq >/dev/null \
    || die "$STORAGE_PARTITION is not the sole PV of $STORAGE_VG"
  sudo -n vgs --reportformat json -o vg_name,pv_count,lv_count \
    | jq -e --arg vg "$STORAGE_VG" \
      -f /opt/echo-ai-agent/current/config/lvm-vg-layout.jq >/dev/null \
    || die "$STORAGE_VG does not have the expected single-PV layout"
  sudo -n lvs --reportformat json -o vg_name,lv_name,segtype \
    | jq -e --arg vg "$STORAGE_VG" --arg thinpool "$STORAGE_THINPOOL" \
      -f /opt/echo-ai-agent/current/config/lvm-thinpool-layout.jq >/dev/null \
    || die "$STORAGE_VG contains an unexpected logical volume"
}

expect_sshd_setting() {
  local config=$1
  local key=$2
  local expected=$3

  grep -Fqx "$key $expected" <<<"$config" \
    || die "unexpected SSH setting: $key"
}

expect_equal hostname "$(hostname)" "$EXPECTED_HOSTNAME"
expect_equal incus_version "$(dpkg-query -W -f='${Version}' incus)" "$INCUS_DEBIAN_VERSION"
expect_equal storage_driver \
  "$(incus storage show "$STORAGE_POOL" | awk '$1 == "driver:" { print $2 }')" lvm
expect_equal storage_source \
  "$(incus storage get "$STORAGE_POOL" source)" "$STORAGE_POOL"
expect_equal storage_initial_source \
  "$(incus storage get "$STORAGE_POOL" volatile.initial_source)" "$STORAGE_PARTITION"
expect_equal storage_vg \
  "$(incus storage get "$STORAGE_POOL" lvm.vg_name)" "$STORAGE_VG"
expect_equal storage_thinpool_name \
  "$(incus storage get "$STORAGE_POOL" lvm.thinpool_name)" "$STORAGE_THINPOOL"
expect_equal storage_thinpool \
  "$(incus storage get "$STORAGE_POOL" lvm.use_thinpool)" true
verify_lvm_layout
expect_equal bridge_ipv4 \
  "$(incus network get "$AGENT_BRIDGE" ipv4.address)" "$AGENT_BRIDGE_IPV4"
expect_equal bridge_nat "$(incus network get "$AGENT_BRIDGE" ipv4.nat)" true
expect_equal bridge_ipv6 "$(incus network get "$AGENT_BRIDGE" ipv6.address)" none
expect_equal profile_cpu "$(incus profile get "$AGENT_PROFILE" limits.cpu)" "$AGENT_CPU_LIMIT"
expect_equal profile_memory \
  "$(incus profile get "$AGENT_PROFILE" limits.memory)" "$AGENT_MEMORY_LIMIT"
expect_equal profile_processes \
  "$(incus profile get "$AGENT_PROFILE" limits.processes)" "$AGENT_PROCESS_LIMIT"
expect_equal profile_autostart \
  "$(incus profile get "$AGENT_PROFILE" boot.autostart)" false
expect_equal profile_guestapi \
  "$(incus profile get "$AGENT_PROFILE" security.guestapi)" false
expect_equal profile_guestapi_images \
  "$(incus profile get "$AGENT_PROFILE" security.guestapi.images)" false
expect_equal profile_nesting \
  "$(incus profile get "$AGENT_PROFILE" security.nesting)" false
expect_equal profile_privileged \
  "$(incus profile get "$AGENT_PROFILE" security.privileged)" false
expect_equal profile_root_pool \
  "$(incus profile device get "$AGENT_PROFILE" root pool)" "$STORAGE_POOL"
expect_equal profile_root_size \
  "$(incus profile device get "$AGENT_PROFILE" root size)" "$AGENT_ROOT_SIZE"
expect_equal profile_network \
  "$(incus profile device get "$AGENT_PROFILE" eth0 network)" "$AGENT_BRIDGE"
expect_equal profile_ipv4_filtering \
  "$(incus profile device get "$AGENT_PROFILE" eth0 security.ipv4_filtering)" true
expect_equal profile_mac_filtering \
  "$(incus profile device get "$AGENT_PROFILE" eth0 security.mac_filtering)" true
expect_equal profile_port_isolation \
  "$(incus profile device get "$AGENT_PROFILE" eth0 security.port_isolation)" true

sudo -n systemctl is-enabled --quiet echo-ai-agent-firewall.service
sudo -n systemctl is-active --quiet echo-ai-agent-firewall.service
sudo -n systemctl is-enabled --quiet echo-ai-agent-sshd.service
sudo -n systemctl is-active --quiet echo-ai-agent-sshd.service
sudo -n nft list chain inet echo_ai_agent host_input >/dev/null
sudo -n nft list chain inet echo_ai_agent container_forward >/dev/null
sudo -n nft list chain bridge echo_ai_agent_bridge container_l2 >/dev/null
sudo -n sshd -t -f /etc/echo-ai-agent/sshd_config
sudo -n ss -H -ltnp "sport = :$DISPATCH_PORT" | grep -Fq 'sshd'
sudo -n ss -H -ltnp 'sport = :22' | grep -Fq 'sshd'
sudo -n ssh-keygen -lf /etc/echo-ai-agent/ssh_host_ed25519_key.pub

dispatcher_sshd=$(sudo -n sshd -T -f /etc/echo-ai-agent/sshd_config \
  -C "user=nobody,host=$EXPECTED_HOSTNAME,addr=127.0.0.1")
expect_sshd_setting "$dispatcher_sshd" authenticationmethods publickey
expect_sshd_setting "$dispatcher_sshd" passwordauthentication no
expect_sshd_setting "$dispatcher_sshd" kbdinteractiveauthentication no
expect_sshd_setting "$dispatcher_sshd" permitemptypasswords no
expect_sshd_setting "$dispatcher_sshd" allowgroups "$DISPATCH_GROUP"
expect_sshd_setting "$dispatcher_sshd" forcecommand \
  /usr/local/libexec/echo-ai-agent-force-command

main_sshd=$(sudo -n sshd -T \
  -C "user=nobody,host=$EXPECTED_HOSTNAME,addr=127.0.0.1")
expect_sshd_setting "$main_sshd" passwordauthentication no
expect_sshd_setting "$main_sshd" kbdinteractiveauthentication no
expect_sshd_setting "$main_sshd" authorizedkeyscommand none
expect_sshd_setting "$main_sshd" forcecommand none

current_release=$(readlink -f /opt/echo-ai-agent/current)
[[ "$current_release" == /opt/echo-ai-agent/releases/* ]] \
  || die "current release resolves outside the release directory"
unsafe=$(sudo -n find "$current_release" \
  \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) \
  -print -quit)
[[ -z "$unsafe" ]] || die "release contains unsafe ownership or mode: $unsafe"
verify_protected_file /usr/local/libexec/echo-ai-agent-dispatch
verify_protected_file /usr/local/libexec/echo-ai-agent-force-command
verify_protected_file /usr/local/libexec/echo-ai-agent-prepare-dispatcher-homes
verify_protected_file /usr/local/libexec/echo-ai-agent-apply-firewall
verify_protected_file /etc/echo-ai-agent/sshd_config
verify_protected_file /etc/echo-ai-agent/echo-ai-agent.nft

expect_equal dispatcher_namespace_dir_owner \
  "$(sudo -n stat -c '%U:%G:%a' "$DISPATCH_NAMESPACE_DIR")" root:root:755
expect_equal dispatcher_runtime_root \
  "$(sudo -n stat -c '%U:%G:%a' "$DISPATCH_RUNTIME_ROOT")" \
  "root:$DISPATCH_GROUP:750"
expect_equal dispatcher_lock \
  "$(sudo -n stat -c '%U:%G:%a' "$DISPATCH_LOCK_PATH")" \
  "root:$DISPATCH_GROUP:660"

declare -A dispatcher_keys=()
identity_count=0
while IFS= read -r -d '' namespace_file; do
  dispatcher_user=$(basename "$namespace_file")
  namespace=$(sudo -n cat "$namespace_file")
  expected_user=$(/opt/echo-ai-agent/current/bin/dispatcher-identity.sh "$namespace")
  expect_equal dispatcher_user "$dispatcher_user" "$expected_user"
  verify_protected_file "$namespace_file"

  account_record=$(getent passwd "$dispatcher_user")
  [[ -n "$account_record" ]] || die "dispatcher account is missing: $dispatcher_user"
  expect_equal "$dispatcher_user home" \
    "$(cut -d: -f6 <<<"$account_record")" \
    "$DISPATCH_RUNTIME_ROOT/$dispatcher_user"
  expect_equal "$dispatcher_user primary group" \
    "$(id -gn "$dispatcher_user")" "$DISPATCH_GROUP"
  id -nG "$dispatcher_user" | tr ' ' '\n' | grep -Fqx incus-admin \
    || die "$dispatcher_user is not in incus-admin"
  expect_equal "$dispatcher_user runtime home" \
    "$(sudo -n stat -c '%U:%G:%a' "$DISPATCH_RUNTIME_ROOT/$dispatcher_user")" \
    "$dispatcher_user:$DISPATCH_GROUP:700"
  shadow_hash=$(sudo -n getent shadow "$dispatcher_user" | cut -d: -f2)
  [[ "$shadow_hash" =~ ^\$6\$ ]] \
    || die "$dispatcher_user has an unexpected password hash"

  key_file="/etc/echo-ai-agent/authorized_keys/$dispatcher_user"
  if [[ -s "$key_file" ]]; then
    expect_equal "$key_file owner" \
      "$(sudo -n stat -c '%U:%G:%a' "$key_file")" \
      "root:$DISPATCH_GROUP:640"
    read -r key_options key_type key_data key_namespace \
      <<<"$(sudo -n cat "$key_file")"
    [[ "$key_options" == restrict && "$key_type" == ssh-ed25519 \
      && -n "$key_data" && "$key_namespace" == "$namespace" ]] \
      || die "invalid dispatcher authorized key: $key_file"
    [[ -z ${dispatcher_keys[$key_data]:-} ]] \
      || die "dispatcher key is reused by multiple Echo servers"
    dispatcher_keys[$key_data]=$namespace
    sudo -n ssh-keygen -lf "$key_file"
  else
    printf '[echo-ai-agent] dispatcher key is not provisioned namespace=%s\n' \
      "$namespace"
  fi
  identity_count=$((identity_count + 1))
done < <(sudo -n find "$DISPATCH_NAMESPACE_DIR" -mindepth 1 -maxdepth 1 \
  -type f -print0 | sort -z)

while IFS= read -r -d '' key_file; do
  dispatcher_user=$(basename "$key_file")
  [[ -f "$DISPATCH_NAMESPACE_DIR/$dispatcher_user" ]] \
    || die "dispatcher key has no namespace mapping: $dispatcher_user"
done < <(sudo -n find /etc/echo-ai-agent/authorized_keys \
  -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)

running=$(incus list --format json | jq \
  '[.[] | select(.name | startswith("echo-ai-agent-"))
    | select(.config["user.echo.ai.managed"] == "true")
    | select(.config["user.echo.ai.template.ready"] != "true")
    | select(.status == "RUNNING")] | length')
((running <= AGENT_MAX_RUNNING)) || die "more than $AGENT_MAX_RUNNING agents are running"

if incus info "$AGENT_TEMPLATE" >/dev/null 2>&1; then
  expect_equal template_status \
    "$(incus list "$AGENT_TEMPLATE" --format csv -c s)" STOPPED
  expect_equal template_ready \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.template.ready)" true
  expect_equal template_harness_release \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.harness_release)" \
    "$HARNESS_RELEASE"
  expect_equal template_guestapi_disabled \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.guestapi_disabled)" true
  expect_equal template_container_uid \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.container_uid)" \
    "$AGENT_CONTAINER_UID"
  expect_equal template_container_gid \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.container_gid)" \
    "$AGENT_CONTAINER_GID"
  expect_equal template_autostart \
    "$(incus config get "$AGENT_TEMPLATE" boot.autostart)" false
  expect_equal template_node \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.node_version)" "$NODE_VERSION"
  expect_equal template_pi \
    "$(incus config get "$AGENT_TEMPLATE" user.echo.ai.pi_version)" "$PI_VERSION"
fi

sudo -n lvs --noheadings -o vg_name,lv_name,segtype,data_percent 2>/dev/null \
  | sed 's/^/[echo-ai-agent] lvm /'
printf '[echo-ai-agent] verification passed; identities=%s running=%s/%s\n' \
  "$identity_count" "$running" "$AGENT_MAX_RUNNING"
