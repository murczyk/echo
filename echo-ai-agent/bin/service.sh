#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

action=${1:?action is required}
target_host=${2:-$DEFAULT_ADMIN_HOST}

require_cmd ssh
case "$action" in
  status)
    ssh_target admin "$target_host" \
      sudo -n systemctl status --no-pager \
      incus.service echo-ai-agent-firewall.service echo-ai-agent-sshd.service
    ssh_target admin "$target_host" incus list '^echo-ai-agent-'
    ;;
  logs)
    ssh_target admin "$target_host" \
      sudo -n journalctl --no-pager --lines 200 \
      --unit echo-ai-agent-firewall.service \
      --unit echo-ai-agent-sshd.service
    ;;
  *)
    die "unsupported service action: $action"
    ;;
esac
