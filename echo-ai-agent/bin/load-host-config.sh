#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2034

source "$BUNDLE_DIR/config/host.env"
source "$BUNDLE_DIR/versions.env"
STORAGE_LAYOUT=audited-partition
if [[ -z ${ECHO_AI_AGENT_HOST_PROFILE:-} && -f /etc/echo-ai-agent/host-profile ]]; then
  [[ ! -L /etc/echo-ai-agent/host-profile \
    && $(stat -c '%U:%G:%a' /etc/echo-ai-agent/host-profile) == root:root:644 ]] \
    || { printf 'unsafe agent host profile\n' >&2; exit 1; }
  ECHO_AI_AGENT_HOST_PROFILE=$(cat /etc/echo-ai-agent/host-profile)
fi
case ${ECHO_AI_AGENT_HOST_PROFILE:-default} in
  default) ;;
  ua) source "$BUNDLE_DIR/config/hosts/ua.env" ;;
  *) printf 'unsupported agent host profile\n' >&2; exit 1 ;;
esac
