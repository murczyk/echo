#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../bin/lib.sh
source "$TEST_DIR/../bin/lib.sh"

case_dir=$(mktemp -d /tmp/echo-control-bundle-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir -p \
  "$case_dir/bin" \
  "$case_dir/env" \
  "$case_dir/shims" \
  "$case_dir/source-systemd" \
  "$case_dir/systemd"
printf '1\n' >"$case_dir/control-protocol-version"
printf 'table\n' >"$case_dir/env/tables-exclude.txt"
printf '{}\n' >"$case_dir/migration-impact.json"
printf 'VERSION=1\n' >"$case_dir/versions.env"
printf 'command\n' >"$case_dir/bin/command.sh"
printf 'shim\n' >"$case_dir/shims/command.sh"
printf 'source unit\n' >"$case_dir/source-systemd/source.service"
printf 'analytics unit\n' >"$case_dir/systemd/analytics.service"

first_release=$(control_bundle_release_id "$case_dir")
printf '%s\n' "$first_release" >"$case_dir/release-id"
[[ $(control_bundle_release_id "$case_dir") == "$first_release" ]]

printf 'ignored\n' >"$case_dir/README.md"
[[ $(control_bundle_release_id "$case_dir") == "$first_release" ]]

printf 'changed command\n' >"$case_dir/bin/command.sh"
second_release=$(control_bundle_release_id "$case_dir")
[[ "$second_release" != "$first_release" ]]
printf '%s\n' "$second_release" >"$case_dir/release-id"

BUNDLE_DIR=$case_dir
ECHO_TEST_REMOTE_RELEASE=$first_release
ssh() {
  printf '%s\n' "$ECHO_TEST_REMOTE_RELEASE"
}
if (require_paired_control_release echo@example.invalid >/dev/null 2>&1); then
  printf 'release handshake unexpectedly accepted mismatched hosts\n' >&2
  exit 1
fi
ECHO_TEST_REMOTE_RELEASE=$second_release
[[ $(require_paired_control_release echo@example.invalid) == "$second_release" ]]

protected_file_exists() { return 0; }
load_source_config() { ANALYTICS_SSH_TARGET=echo@example.invalid; }
require_paired_control_release() { printf '%064d\n' 1; }
ssh() {
  local last_argument=${!#}
  printf '%s\n' "$last_argument" >"$ECHO_TEST_SSH_COMMAND"
}
ECHO_TEST_SSH_COMMAND=$case_dir/ssh-command
(delegate_paired_analytics_operation_if_source finish-resync.sh)
[[ $(<"$ECHO_TEST_SSH_COMMAND") == \
  "sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$(printf '%064d' 1) /opt/echo-analytics/current/bin/finish-resync.sh" ]]
(delegate_paired_analytics_operation_if_source resync.sh --yes)
[[ $(<"$ECHO_TEST_SSH_COMMAND") == \
  "sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$(printf '%064d' 1) /opt/echo-analytics/current/bin/resync.sh --yes" ]]

archive_dir=$case_dir/archive
mkdir "$archive_dir"
archive_control_bundle "$case_dir" | tar -C "$archive_dir" -xf -
[[ ! -e "$archive_dir/README.md" ]]
[[ ! -e "$archive_dir/release-id" ]]
[[ -f "$archive_dir/bin/command.sh" ]]
chmod 0700 "$archive_dir" "$archive_dir/bin"
normalize_control_release_permissions "$archive_dir"
[[ $(stat -c %a "$archive_dir") == 755 ]]
[[ $(stat -c %a "$archive_dir/bin") == 755 ]]
[[ $(stat -c %a "$archive_dir/bin/command.sh") == 755 ]]

printf 'Analytics control bundle tests passed\n'
