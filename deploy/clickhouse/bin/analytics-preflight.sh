#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions
load_instance

[[ $(dpkg --print-architecture) == amd64 ]] || die "only amd64 is supported"
. /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] || die "expected Debian 13, found $ID $VERSION_ID"
[[ $(ps -p 1 -o comm=) == systemd ]] || die "systemd is not PID 1"
sudo -n true || die "passwordless sudo is required"
validate_ipv4_address ANALYTICS_LISTEN_ADDRESS "$ANALYTICS_LISTEN_ADDRESS"
ip -4 -o address show | grep -F " $ANALYTICS_LISTEN_ADDRESS/" >/dev/null \
  || die "analytics listen address is not present: $ANALYTICS_LISTEN_ADDRESS"

memory_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
((memory_kib >= 7 * 1024 * 1024)) \
  || printf '[echo-analytics] WARNING: less than 7 GiB RAM is available\n' >&2

printf 'Host: %s\n' "$(hostname -f 2>/dev/null || hostname)"
printf 'OS: %s %s, %s\n' "$PRETTY_NAME" "$(uname -m)" "$(ldd --version | head -n 1)"
free -h
df -h /

if timeout 5 bash -c "</dev/tcp/$SOURCE_HOST/$SOURCE_PORT" 2>/dev/null; then
  printf 'Source TCP: %s:%s reachable\n' "$SOURCE_HOST" "$SOURCE_PORT"
else
  die "source TCP is not reachable: $SOURCE_HOST:$SOURCE_PORT"
fi

printf '\nExisting listeners on planned ports\n'
ss -H -ltn | awk '
  $4 ~ /:(5432|7233|8112|8113|8123|9000|9002|9003|9900)$/ { print "  " $4 }
'

log "Analytics host preflight passed"
