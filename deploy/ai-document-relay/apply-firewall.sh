#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == echo-ai-agents-ua && $EUID == 0 ]]
table=echo_document_extractor_relay
rules=$(cat <<'NFT'
table inet echo_document_extractor_relay {
  chain input {
    type filter hook input priority filter; policy accept;
    ip daddr 10.190.254.39 tcp dport 8000 ip saddr 10.190.254.11 accept
    ip daddr 10.190.254.39 tcp dport 8000 reject with tcp reset
  }
}
NFT
)
if /usr/sbin/nft list table inet "$table" >/dev/null 2>&1; then
  { printf 'delete table inet %s\n' "$table"; printf '%s\n' "$rules"; } | /usr/sbin/nft -f -
else
  printf '%s\n' "$rules" | /usr/sbin/nft -f -
fi
