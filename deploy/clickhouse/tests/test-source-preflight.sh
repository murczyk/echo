#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../bin/lib.sh
source "$TEST_DIR/../bin/lib.sh"

case_dir=$(mktemp -d /tmp/echo-source-preflight-test.XXXXXX)
trap 'rm -rf -- "$case_dir"' EXIT
SOURCE_PUBLICATION=test_publication
SOURCE_TABLE_EXCLUDE_FILE=$case_dir/exclusions
SOURCE_TABLE_EXCLUDE_REPO_FILE=$case_dir/exclusions
printf 'public.excluded\n' >"$case_dir/exclusions"

query_status=0
query_output=
source_psql() {
  [[ -z "$query_output" ]] || printf '%s\n' "$query_output"
  ((query_status == 0)) || printf 'original PostgreSQL error\n' >&2
  return "$query_status"
}
source_local_psql() { source_psql "$@"; }

for reader in read_source_tables read_local_source_tables; do
  for query_status in 2 3; do
    query_output=public.partial
    status=0
    ("$reader") >"$case_dir/output" 2>&1 || status=$?
    [[ "$status" == "$query_status" ]]
    grep -q 'original PostgreSQL error' "$case_dir/output"
    if grep -Eq 'has no tables|no source tables selected' "$case_dir/output"; then
      printf 'query failure was misreported as an empty table selection\n' >&2
      exit 1
    fi
  done

  query_status=0
  query_output=
  if ("$reader") >"$case_dir/output" 2>&1; then
    printf 'empty selection unexpectedly succeeded\n' >&2
    exit 1
  fi
  grep -Eq 'has no tables|no source tables selected' "$case_dir/output"

  query_output=$'echo_analytics.heartbeat\npublic.selected'
  "$reader"
  [[ ${SOURCE_TABLES[*]} == 'echo_analytics.heartbeat public.selected' ]]
done
query_output=$'public.excluded\npublic.selected'
read_local_source_tables
[[ ${SOURCE_TABLES[*]} == public.selected ]]

mkdir "$case_dir/bin"
cat >"$case_dir/bin/lib.sh" <<'LIB'
set -euo pipefail
SOURCE_CONFIG_FILE=unused
SOURCE_DB=test_database
SOURCE_USER=test_role
SOURCE_PUBLICATION=test_publication
SOURCE_TABLE_EXCLUDE_FILE=unused
SOURCE_TABLE_EXCLUDE_REPO_FILE=unused
SOURCE_RECONCILE_FINGERPRINT_FILE=$ECHO_TEST_FINGERPRINT
protected_file_exists() { return 0; }
load_source_config() { :; }
ensure_yes() { :; }
acquire_source_reconcile_lock() { :; }
require_cmd() { :; }
require_file() { :; }
validate_identifier() { :; }
require_source_replication_role() {
  printf 'role validation failed\n' >&2
  exit 1
}
unexpected_operation() {
  printf '%s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
  exit 90
}
sudo() { unexpected_operation sudo "$@"; }
ssh() { unexpected_operation ssh "$@"; }
install_default_source_exclusions() { unexpected_operation install_exclusions; }
require_analytics_heartbeat_table() { :; }
read_local_source_tables() { :; }
require_analytics_heartbeat_selected() { :; }
source_exclusions_match() { return 0; }
source_table_selection_fingerprint() { printf 'matching\n'; }
source_publication_fingerprint() { printf 'matching\n'; }
LIB
printf 'matching\n' >"$case_dir/fingerprint"

for script in source-reconcile-tables source-reconcile-if-needed \
  source-sync-exclusions source-sync-exclusions-if-needed; do
  cp "$TEST_DIR/../bin/$script.sh" "$case_dir/bin/"
  if ECHO_TEST_FINGERPRINT="$case_dir/fingerprint" \
    ECHO_TEST_OPERATIONS="$case_dir/operations" \
    bash "$case_dir/bin/$script.sh" --yes >"$case_dir/output" 2>&1; then
    printf '%s unexpectedly accepted an invalid role\n' "$script" >&2
    exit 1
  fi
  grep -q 'role validation failed' "$case_dir/output"
  [[ ! -e "$case_dir/operations" ]]
done

printf 'Source preflight and query failure tests passed\n'
