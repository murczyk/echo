#!/usr/bin/env bash

set -euo pipefail

expected_hostname=$1
router_host=$2
signoz_host=$3
signoz_port=$4
shift 4

die() {
  printf '[echo-vllm-router] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

check_platform() {
  [[ $(hostname) == "$expected_hostname" ]] \
    || die "expected hostname $expected_hostname, found $(hostname)"
  [[ $(dpkg --print-architecture) == amd64 ]] || die "only amd64 is supported"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "$ID" == debian && "$VERSION_ID" == 13 ]] \
    || die "expected Debian 13, found $ID $VERSION_ID"
  [[ $(ps -p 1 -o comm=) == systemd ]] || die "systemd is not PID 1"
  [[ $(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")') == 3.13 ]] \
    || die "Python 3.13 is required"
  dpkg-query -W -f='${db:Status-Status}\n' python3-venv 2>/dev/null \
    | grep -Fx 'installed' >/dev/null \
    || die "target prerequisites are missing; run just setup"
  sudo -n true || die "passwordless sudo is required"
}

check_commands() {
  local command_name
  for command_name in curl dpkg-query ip python3 sha256sum ss systemd-analyze tar timeout; do
    require_cmd "$command_name"
  done
  [[ -x /usr/sbin/groupadd ]] || die "missing command: /usr/sbin/groupadd"
  [[ -x /usr/sbin/useradd ]] || die "missing command: /usr/sbin/useradd"
  [[ -x /usr/sbin/usermod ]] || die "missing command: /usr/sbin/usermod"
}

check_identity() {
  local tailscale_ip
  require_cmd tailscale
  tailscale_ip=$(tailscale ip -4 | head -n 1)
  [[ "$tailscale_ip" == "$router_host" ]] \
    || die "expected Tailscale IP $router_host, found $tailscale_ip"
  ip -4 -o address show | grep -F " $router_host/" >/dev/null \
    || die "router IP is not assigned: $router_host"
}

check_tcp() {
  local host=$1
  local port=$2
  timeout 5 bash -c "</dev/tcp/$host/$port" 2>/dev/null \
    || die "TCP endpoint is unreachable: $host:$port"
}

check_backend() {
  local pool=$1
  local worker_url=$2
  local expected_model_id=$3

  curl -fsS --max-time 10 "$worker_url/health" >/dev/null \
    || die "worker health check failed for $pool: $worker_url/health"
  curl -fsS --max-time 10 "$worker_url/v1/models" \
    | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); assert {item["id"] for item in data["data"]} == {expected}' "$expected_model_id" \
    || die "worker in $pool does not expose only model $expected_model_id"
  curl -fsS --max-time 10 "$worker_url/metrics" \
    | python3 -c 'import sys; data=sys.stdin.read(); assert any(line.startswith("vllm:") for line in data.splitlines())' \
    || die "worker metrics are unavailable for $pool"
}

check_port() {
  local port=$1
  local unit=$2

  if ss -H -ltn | awk -v suffix=":$port" '$4 ~ suffix "$" { found=1 } END { exit !found }'; then
    systemctl is-active --quiet "$unit" \
      || die "port $port is occupied outside $unit"
  fi
}

check_platform
check_commands
check_identity
check_tcp "$signoz_host" "$signoz_port"

(( $# > 0 && $# % 6 == 0 )) || die "invalid pool preflight arguments"
while (( $# > 0 )); do
  pool=$1
  unit=$2
  router_port=$3
  router_metrics_port=$4
  expected_model_id=$5
  worker_urls_csv=$6
  shift 6

  IFS=, read -r -a worker_urls <<<"$worker_urls_csv"
  for worker_url in "${worker_urls[@]}"; do
    worker_endpoint=${worker_url#*://}
    check_tcp "${worker_endpoint%:*}" "${worker_endpoint##*:}"
    check_backend "$pool" "$worker_url" "$expected_model_id"
  done
  check_port "$router_port" "$unit"
  check_port "$router_metrics_port" "$unit"
  printf 'Pool %s: backends %s healthy, exact model %s present\n' \
    "$pool" "$worker_urls_csv" "$expected_model_id"
done

printf 'Host: %s (%s)\n' "$(hostname)" "$router_host"
printf 'SigNoz OTLP: %s:%s reachable\n' "$signoz_host" "$signoz_port"
printf '[echo-vllm-router] Preflight passed\n'
