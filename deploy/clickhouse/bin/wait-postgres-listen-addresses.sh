#!/usr/bin/env bash

# Runs before PostgreSQL starts, from the drop-in that
# install-control-release.sh writes. PostgreSQL skips a listen address that does
# not exist yet and never retries it, so its socket stays missing until the next
# restart. This does not source lib.sh: it must work this early in boot.
#
# Always exits 0. Local services need PostgreSQL even if an address stays absent.

set -u

cluster=${1:?usage: wait-postgres-listen-addresses.sh <version>-<cluster>}
wait_seconds=${ECHO_POSTGRES_LISTEN_WAIT_SECONDS:-30}
version=${cluster%%-*}
name=${cluster#*-}

effective_listen_addresses() {
  runuser -u postgres -- "/usr/lib/postgresql/$version/bin/postgres" \
    -C listen_addresses \
    --config-file="/etc/postgresql/$version/$name/postgresql.conf" 2>/dev/null
}

ip_is_local() {
  [[ -n $(ip -o addr show to "$1" 2>/dev/null) ]]
}

address_is_ready() {
  local address=$1 resolved
  case $address in
    '*' | '' | localhost) return 0 ;;
  esac
  if [[ $address =~ ^[0-9.]+$ || $address == *:* ]]; then
    ip_is_local "$address"
    return
  fi
  for resolved in $(getent ahosts "$address" 2>/dev/null | awk '{print $1}' | sort -u); do
    ip_is_local "$resolved" && return 0
  done
  return 1
}

listen_addresses=$(effective_listen_addresses) || true
if [[ -z $listen_addresses ]]; then
  echo "listen_addresses is unreadable for $cluster; not waiting"
  exit 0
fi
IFS=', ' read -r -a addresses <<<"$listen_addresses"

deadline=$((SECONDS + wait_seconds))
while :; do
  missing=()
  for address in "${addresses[@]}"; do
    address_is_ready "$address" || missing+=("$address")
  done
  if ((${#missing[@]} == 0)); then
    echo "listen addresses ready after ${SECONDS}s: $listen_addresses"
    exit 0
  fi
  if ((SECONDS >= deadline)); then
    echo "WARNING: listen addresses absent after ${wait_seconds}s: ${missing[*]}; starting PostgreSQL anyway" >&2
    exit 0
  fi
  sleep 0.5
done
