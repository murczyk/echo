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

