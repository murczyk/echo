#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

role=${1:-}
expected_release=${2:-}
case $role in
  source)
    install_root=/opt/echo-peerdb
    unit_dir=$BUNDLE_DIR/source-systemd
    ;;
  analytics)
    install_root=/opt/echo-analytics
    unit_dir=$BUNDLE_DIR/systemd
    ;;
  *)
    die "usage: $0 source|analytics RELEASE_ID"
    ;;
esac
[[ "$expected_release" =~ ^[a-f0-9]{64}$ ]] \
  || die "invalid control release id: $expected_release"
require_cmd find
require_cmd install
require_cmd systemctl
require_cmd tar

actual_release=$(control_bundle_release_id "$BUNDLE_DIR")
[[ "$actual_release" == "$expected_release" ]] \
  || die "control bundle checksum mismatch: expected $expected_release, got $actual_release"

stage_dir=
analytics_health_was_active=false
analytics_reconcile_was_active=false
analytics_memory_limit_was_active=false
restore_interrupted_services() {
  if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
  if $analytics_health_was_active; then
    systemctl enable --now echo-analytics-health.timer >/dev/null 2>&1 || true
  fi
  if $analytics_reconcile_was_active; then
    systemctl enable --now echo-analytics-reconcile.timer >/dev/null 2>&1 || true
  fi
  if $analytics_memory_limit_was_active; then
    systemctl enable --now echo-analytics-memory-limit.timer >/dev/null 2>&1 || true
  fi
}
trap restore_interrupted_services EXIT

if [[ $role == analytics ]]; then
  acquire_analytics_reconcile_lock
  systemctl is-active --quiet echo-analytics-health.timer \
    && analytics_health_was_active=true
  systemctl is-active --quiet echo-analytics-reconcile.timer \
    && analytics_reconcile_was_active=true
  systemctl is-active --quiet echo-analytics-memory-limit.timer \
    && analytics_memory_limit_was_active=true
  systemctl stop echo-analytics-health.timer echo-analytics-reconcile.timer \
    echo-analytics-memory-limit.timer \
    >/dev/null 2>&1 || true
  systemctl stop echo-analytics-health.service echo-analytics-reconcile.service \
    echo-analytics-memory-limit.service \
    >/dev/null 2>&1 || true
fi

install -d -o root -g root -m 0755 "$install_root/releases"
release_dir=$install_root/releases/$expected_release
if [[ ! -d "$release_dir" ]]; then
  stage_dir=$(mktemp -d "$install_root/releases/.${expected_release}.XXXXXX")
  archive_control_bundle "$BUNDLE_DIR" | tar -C "$stage_dir" -xf -
  printf '%s\n' "$expected_release" >"$stage_dir/release-id"
  chown -R root:root "$stage_dir"
  mv "$stage_dir" "$release_dir"
  stage_dir=
else
  installed_release=$(control_bundle_release_id "$release_dir")
  [[ "$installed_release" == "$expected_release" ]] \
    || die "installed control release $expected_release has checksum $installed_release"
fi
normalize_control_release_permissions "$release_dir"

for unit in "$unit_dir"/*; do
  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload

temporary_link=$install_root/.current.$$
ln -s "releases/$expected_release" "$temporary_link"
mv -Tf "$temporary_link" "$install_root/current"

if [[ $role == source ]]; then
  systemctl enable \
    echo-peerdb-wal-monitor.timer \
    echo-peerdb-table-reconcile.timer >/dev/null
else
  install -d -o postgres -g postgres -m 0755 "$ANALYTICS_RECONCILE_STATE_DIR"
  install -d -o root -g root -m 0755 "$install_root/bin"
  for command_path in "$release_dir"/bin/*.sh; do
    ln -sfnT "../current/bin/$(basename "$command_path")" \
      "$install_root/bin/$(basename "$command_path")"
  done
  "$install_root/current/bin/reconcile-clickhouse-memory-limit.sh"
  systemctl enable \
    echo-analytics-memory-limit.timer \
    echo-analytics-health.timer \
    echo-analytics-reconcile.timer >/dev/null
  if [[ ${ECHO_ANALYTICS_CONTROL_START_TIMERS:-true} == true ]]; then
    systemctl start \
      echo-analytics-memory-limit.timer \
      echo-analytics-health.timer \
      echo-analytics-reconcile.timer >/dev/null
  else
    if $analytics_health_was_active; then
      systemctl start echo-analytics-health.timer >/dev/null
    fi
    if $analytics_reconcile_was_active; then
      systemctl start echo-analytics-reconcile.timer >/dev/null
    fi
    if $analytics_memory_limit_was_active; then
      systemctl start echo-analytics-memory-limit.timer >/dev/null
    fi
  fi
fi

trap - EXIT
log "Activated $role analytics control release $expected_release"
