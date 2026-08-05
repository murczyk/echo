#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

INSTALL_ROOT=/opt/echo-ai-agent
previous=$(readlink "$INSTALL_ROOT/previous" 2>/dev/null || true)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
dangerously_acknowledge=${1:-}
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../config/host.env"

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "rollback-host.sh must run as root"
[[ "$dangerously_acknowledge" == true ]] \
  || die "missing dangerous-operation acknowledgement"
[[ "$previous" =~ ^releases/[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] \
  || die "no safe previous release is recorded"
[[ -d "$INSTALL_ROOT/$previous" ]] || die "previous release is missing"

exec 9>/run/lock/echo-ai-agent-deploy.lock
flock -n 9 || die "another deployment is running"
python3 "$SCRIPT_DIR/check-rollback-compatibility.py" \
  "$INSTALL_ROOT/$previous/dispatcher/echo_ai_agent_dispatcher.py" \
  "$DISPATCH_VERIFY_NAMESPACE" \
  || die "previous release is incompatible with the current fixed template"
current=$(readlink "$INSTALL_ROOT/current")
ln -sfn "$current" "$INSTALL_ROOT/rollback-origin"
next_link="$INSTALL_ROOT/.current.$$"
ln -s "$previous" "$next_link"
mv -Tf "$next_link" "$INSTALL_ROOT/current"
release="$INSTALL_ROOT/current"
install -m 0644 "$release/config/sshd_config" /etc/echo-ai-agent/sshd_config
install -m 0644 "$release/config/echo-ai-agent.nft" /etc/echo-ai-agent/echo-ai-agent.nft
install -m 0644 "$release/systemd/echo-ai-agent-firewall.service" \
  /etc/systemd/system/echo-ai-agent-firewall.service
install -m 0644 "$release/systemd/echo-ai-agent-sshd.service" \
  /etc/systemd/system/echo-ai-agent-sshd.service
systemctl daemon-reload
systemctl restart echo-ai-agent-firewall.service echo-ai-agent-sshd.service
printf '[echo-ai-agent] rolled back from %s to %s\n' "$current" "$previous"
printf '[echo-ai-agent] storage, instances, and main admin SSH port were retained\n'
