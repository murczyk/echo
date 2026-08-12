#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC1091
source "$BUNDLE_DIR/config/host.env"
# shellcheck disable=SC1091
source "$BUNDLE_DIR/versions.env"

dangerously_acknowledge=${1:-}
artifact_dir=
template_created=0

die() {
  printf '[echo-ai-agent] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$artifact_dir" && "$artifact_dir" == /tmp/echo-ai-agent-template.* ]]; then
    rm -rf -- "$artifact_dir"
  fi
  if [[ $template_created -eq 1 ]]; then
    incus stop "$AGENT_TEMPLATE" --force >/dev/null 2>&1 || true
    incus config set "$AGENT_TEMPLATE" security.protection.delete=false \
      >/dev/null 2>&1 || true
    incus delete "$AGENT_TEMPLATE" --force >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

template_is_current() {
  [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.template.ready) == true ]] \
    && [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.harness_release) == "$HARNESS_RELEASE" ]] \
    && [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.guestapi_disabled) == true ]] \
    && [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.container_uid) == "$AGENT_CONTAINER_UID" ]] \
    && [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.container_gid) == "$AGENT_CONTAINER_GID" ]] \
    && [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.node_version) == "$NODE_VERSION" ]] \
    && [[ $(incus config get "$AGENT_TEMPLATE" user.echo.ai.pi_version) == "$PI_VERSION" ]] \
    && [[ $(incus list "$AGENT_TEMPLATE" --format csv -c s) == STOPPED ]]
}

prepare_node() {
  local archive="$artifact_dir/$NODE_ARCHIVE"

  curl -fsSL --retry 3 --output "$archive" "$NODE_ARCHIVE_URL"
  printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" "$archive" \
    | sha256sum --check --status - \
    || die "Node archive checksum mismatch"
}

prepare_pi() {
  local archive="$artifact_dir/$PI_ARCHIVE"

  curl -fsSL --retry 3 --output "$archive" "$PI_TARBALL_URL"
  printf '%s  %s\n' "$PI_TARBALL_SHA256" "$archive" \
    | sha256sum --check --status - \
    || die "Pi archive checksum mismatch"
}

push_template_files() {
  incus exec "$AGENT_TEMPLATE" -- mkdir -p /var/tmp/echo-ai-agent-template
  incus file push \
    "$artifact_dir/$NODE_ARCHIVE" \
    "$AGENT_TEMPLATE/var/tmp/echo-ai-agent-template/$NODE_ARCHIVE"
  incus file push \
    "$artifact_dir/$PI_ARCHIVE" \
    "$AGENT_TEMPLATE/var/tmp/echo-ai-agent-template/$PI_ARCHIVE"
  incus file push \
    "$BUNDLE_DIR/package.json" \
    "$BUNDLE_DIR/package-lock.json" \
    "$BUNDLE_DIR/template/bootstrap.sh" \
    "$BUNDLE_DIR/template/configure-network.sh" \
    "$BUNDLE_DIR/runner/echo-ai-agent-runner" \
    "$BUNDLE_DIR/runner/runner.ts" \
    "$AGENT_TEMPLATE/var/tmp/echo-ai-agent-template/"
  incus exec "$AGENT_TEMPLATE" -- mkdir -p \
    /var/tmp/echo-ai-agent-template/skills/echo-read-only
  incus file push \
    "$BUNDLE_DIR/template/skills/echo-read-only/SKILL.md" \
    "$AGENT_TEMPLATE/var/tmp/echo-ai-agent-template/skills/echo-read-only/SKILL.md"
}

[[ $EUID -eq 0 ]] || die "build-template-host.sh must run as root"
[[ $(hostname) == "$EXPECTED_HOSTNAME" ]] || die "unexpected host"
[[ "$dangerously_acknowledge" == true ]] \
  || die "missing dangerous-operation acknowledgement"
[[ -L /opt/echo-ai-agent/current ]] || die "host bundle is not deployed"

exec 9>/run/lock/echo-ai-agent-template.lock
flock -n 9 || die "another template build is running"
if incus info "$AGENT_TEMPLATE" >/dev/null 2>&1; then
  template_is_current && {
    printf '[echo-ai-agent] fixed template is already ready\n'
    exit 0
  }
  die "fixed template exists but is not the expected ready template"
fi

artifact_dir=$(mktemp -d /tmp/echo-ai-agent-template.XXXXXX)
prepare_node
prepare_pi
incus launch "$DEBIAN_IMAGE" "$AGENT_TEMPLATE" --profile "$AGENT_PROFILE"
template_created=1
incus exec "$AGENT_TEMPLATE" -- cloud-init status --wait
incus exec "$AGENT_TEMPLATE" -- test ! -S /dev/incus/sock \
  || die "Incus guest API socket is exposed inside the template"
push_template_files
incus exec "$AGENT_TEMPLATE" -- \
  /bin/bash /var/tmp/echo-ai-agent-template/bootstrap.sh \
  "$NODE_VERSION" \
  "$NODE_ARCHIVE" \
  "$NODE_ARCHIVE_SHA256" \
  "$PI_VERSION" \
  "$PI_ARCHIVE" \
  "$PI_TARBALL_SHA256" \
  "$AGENT_CONTAINER_USER" \
  "$AGENT_CONTAINER_UID" \
  "$AGENT_CONTAINER_GID"
[[ $(incus exec "$AGENT_TEMPLATE" -- id -u "$AGENT_CONTAINER_USER") == "$AGENT_CONTAINER_UID" ]] \
  || die "template agent UID mismatch"
[[ $(incus exec "$AGENT_TEMPLATE" -- id -g "$AGENT_CONTAINER_USER") == "$AGENT_CONTAINER_GID" ]] \
  || die "template agent GID mismatch"
[[ $(incus exec "$AGENT_TEMPLATE" -- stat -c '%u:%g' /home/echo) \
  == "$AGENT_CONTAINER_UID:$AGENT_CONTAINER_GID" ]] \
  || die "template agent home ownership mismatch"
incus exec "$AGENT_TEMPLATE" -- rm -rf /var/tmp/echo-ai-agent-template
incus stop "$AGENT_TEMPLATE" --timeout 60
incus config set "$AGENT_TEMPLATE" \
  boot.autostart=false \
  user.echo.ai.template.ready=true \
  user.echo.ai.harness_release="$HARNESS_RELEASE" \
  user.echo.ai.guestapi_disabled=true \
  user.echo.ai.container_uid="$AGENT_CONTAINER_UID" \
  user.echo.ai.container_gid="$AGENT_CONTAINER_GID" \
  user.echo.ai.node_version="$NODE_VERSION" \
  user.echo.ai.pi_version="$PI_VERSION" \
  user.echo.ai.source_image="$(incus config get "$AGENT_TEMPLATE" volatile.base_image)" \
  security.protection.delete=true
template_created=0
printf '[echo-ai-agent] fixed template built and stopped\n'
