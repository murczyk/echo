#!/usr/bin/env bash

log() {
  printf '[test] %s\n' "$*"
}

die() {
  printf '[test] ERROR: %s\n' "$*" >&2
  exit 1
}

validate_identifier() {
  [[ "$2" =~ ^[a-z_][a-z0-9_]*$ ]] || die "invalid identifier: $2"
}

source_table_cdc_only() {
  [[ "$1" == public.attachment_document || "$1" == public.attachment_chunk ]]
}

invalidate_attachment_search_coverage() {
  printf 'invalidate-coverage\n' >>"$ECHO_RESNAPSHOT_TEST_CASE_DIR/operations"
}

