#!/usr/bin/env bash

set -euo pipefail

/usr/sbin/nft delete table inet echo_analytics_guard 2>/dev/null || true
/usr/sbin/nft -f - <<EOF
table inet echo_analytics_guard {
  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr $ANALYTICS_ALLOWED_CLIENT tcp dport ${ANALYTICS_GATEWAY_PORT:-5432} counter accept
    iifname != "lo" tcp dport ${ANALYTICS_GATEWAY_PORT:-5432} counter drop
    iifname != "lo" tcp dport { ${PEERDB_FLOW_GRPC_PORT:-8112}, ${PEERDB_FLOW_HTTP_PORT:-8113} } counter drop
  }
}
EOF
