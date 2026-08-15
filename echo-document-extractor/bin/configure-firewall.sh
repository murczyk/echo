#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
SOURCE_FILE=${SOURCE_FILE:-/etc/echo-document-extractor/firewall-sources.conf}
NFT_BIN=${NFT_BIN:-/usr/sbin/nft}
IP_BIN=${IP_BIN:-/usr/sbin/ip}
API_INTERFACE=${API_INTERFACE:-tailscale0}
API_ADDRESS=${API_ADDRESS:-100.93.77.92}
API_PORT=${API_PORT:-8000}
TABLE_NAME=echo_document_extractor
MODE=${1:-apply}

[[ "$MODE" == apply || "$MODE" == check || "$MODE" == remove ]] || {
  printf 'usage: %s [apply|check|remove]\n' "$0" >&2
  exit 2
}
command -v "$NFT_BIN" >/dev/null || { printf 'nft is unavailable\n' >&2; exit 1; }
if [[ $EUID -ne 0 && "$NFT_BIN" == /usr/sbin/nft ]]; then
  printf 'firewall configuration requires root\n' >&2
  exit 1
fi
if [[ "$MODE" == remove ]]; then
  "$NFT_BIN" delete table inet "$TABLE_NAME" 2>/dev/null || true
  exit 0
fi

[[ -r "$SOURCE_FILE" ]] || { printf 'firewall source file is unavailable: %s\n' "$SOURCE_FILE" >&2; exit 1; }
command -v "$IP_BIN" >/dev/null || { printf 'ip is unavailable\n' >&2; exit 1; }
"$IP_BIN" link show dev "$API_INTERFACE" >/dev/null
"$IP_BIN" -4 addr show dev "$API_INTERFACE" | grep -F " $API_ADDRESS/" >/dev/null

declare -a source_hosts=()
declare -a source_addresses=()
declare -A seen_hosts=()
declare -A seen_addresses=()
while read -r source_host source_address extra; do
  [[ -n ${source_host:-} && ${source_host:0:1} != '#' ]] || continue
  [[ -z ${extra:-} && "$source_host" =~ ^[a-z0-9-]+$ \
    && "$source_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
    printf 'invalid firewall source entry: %s %s %s\n' \
      "$source_host" "${source_address:-}" "${extra:-}" >&2
    exit 1
  }
  "$IP_BIN" route get "$source_address" >/dev/null
  [[ -z ${seen_hosts[$source_host]:-} && -z ${seen_addresses[$source_address]:-} ]] || {
    printf 'duplicate firewall source entry: %s %s\n' "$source_host" "$source_address" >&2
    exit 1
  }
  seen_hosts[$source_host]=1
  seen_addresses[$source_address]=1
  source_hosts+=("$source_host")
  source_addresses+=("$source_address")
done <"$SOURCE_FILE"
(( ${#source_hosts[@]} == 7 )) || {
  printf 'exactly seven firewall sources are required, found %d\n' "${#source_hosts[@]}" >&2
  exit 1
}

policy_hash=$(
  {
    printf '%s\n%s\n%s\n' "$API_INTERFACE" "$API_ADDRESS" "$API_PORT"
    sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$SOURCE_FILE"
  } | sha256sum | awk '{print $1}'
)

check_policy() {
  local rules
  rules=$("$NFT_BIN" list table inet "$TABLE_NAME")
  grep -F "comment \"policy-sha256-$policy_hash\"" <<<"$rules" >/dev/null
  grep -F "hook input priority filter; policy accept;" <<<"$rules" >/dev/null
  grep -F "iifname \"$API_INTERFACE\"" <<<"$rules" | grep -F "ip daddr $API_ADDRESS" \
    | grep -F "tcp dport $API_PORT" | grep -F 'reject with tcp reset' >/dev/null
  local source_address
  for source_address in "${source_addresses[@]}"; do
    grep -F "$source_address" <<<"$rules" >/dev/null || return 1
  done
}

if [[ "$MODE" == check ]]; then
  check_policy
  printf 'Extractor nftables policy is active for seven sources\n'
  exit 0
fi

elements=$(printf '%s, ' "${source_addresses[@]}")
elements=${elements%, }
rules=$(printf '%s\n' \
  "table inet $TABLE_NAME {" \
  "  comment \"policy-sha256-$policy_hash\"" \
  '  set allowed_sources {' \
  '    type ipv4_addr' \
  '    flags constant' \
  "    elements = { $elements }" \
  '  }' \
  '  chain input {' \
  '    type filter hook input priority filter; policy accept;' \
  "    iifname \"$API_INTERFACE\" ip daddr $API_ADDRESS tcp dport $API_PORT ip saddr @allowed_sources counter accept comment \"allowed Echo hosts\"" \
  "    iifname \"$API_INTERFACE\" ip daddr $API_ADDRESS tcp dport $API_PORT counter reject with tcp reset comment \"deny other extractor clients\"" \
  '  }' \
  '}')
if "$NFT_BIN" list table inet "$TABLE_NAME" >/dev/null 2>&1; then
  { printf 'delete table inet %s\n' "$TABLE_NAME"; printf '%s\n' "$rules"; } | "$NFT_BIN" --file -
else
  printf '%s\n' "$rules" | "$NFT_BIN" --file -
fi
check_policy
printf 'Extractor nftables policy applied for seven sources\n'
