#!/usr/bin/env bash
set -euo pipefail
TARGET_HOST=${1:-${TARGET_HOST:-echo-document-extractor}}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
while read -r client expected_source extra; do
  [[ -n ${client:-} && ${client:0:1} != '#' ]] || continue
  [[ -z ${extra:-} ]] || { printf 'invalid firewall source entry for %s\n' "$client" >&2; exit 1; }
  actual_source=$(ssh -n -o BatchMode=yes "$client" \
    "ip -4 route get 100.93.77.92 | awk '{for (i=1; i<=NF; i++) if (\$i == \"src\") {print \$(i+1); exit}}'")
  [[ "$actual_source" == "$expected_source" ]] || {
    printf '%s reaches the extractor from %s, expected %s\n' \
      "$client" "$actual_source" "$expected_source" >&2
    exit 1
  }
done <"$SCRIPT_DIR/../config/firewall-sources.conf"
ssh -o BatchMode=yes "$TARGET_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] || { printf 'Debian 13 is required\n' >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { printf 'amd64 is required\n' >&2; exit 1; }
[[ $(hostname) == ct-echo-document-extractor ]] \
  || { printf 'unexpected target hostname: %s\n' "$(hostname)" >&2; exit 1; }
[[ $(ps -p 1 -o comm=) == systemd ]] || { printf 'systemd is not PID 1\n' >&2; exit 1; }
sudo /usr/sbin/nft list ruleset >/dev/null 2>&1 \
  || { printf 'target lacks the netfilter capability required by nftables\n' >&2; exit 1; }
ip -4 addr show | grep -F '100.93.77.92/' >/dev/null \
  || { printf 'target does not own 100.93.77.92\n' >&2; exit 1; }
for endpoint in http://100.105.172.96:8001/health http://100.105.172.96:8002/health; do
  curl -fsS --max-time 10 "$endpoint" >/dev/null
done
free_bytes=$(df -PB1 /var/lib 2>/dev/null | awk 'NR == 2 {print $4}')
(( free_bytes >= 21474836480 )) || { printf 'less than 20 GiB is free\n' >&2; exit 1; }
REMOTE
