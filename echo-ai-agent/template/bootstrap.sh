#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

NODE_VERSION=${1:?Node version is required}
NODE_ARCHIVE=${2:?Node archive is required}
NODE_ARCHIVE_SHA256=${3:?Node checksum is required}
PI_VERSION=${4:?Pi version is required}
PI_ARCHIVE=${5:?Pi archive is required}
PI_TARBALL_SHA256=${6:?Pi checksum is required}
AGENT_USER=${7:?Agent user is required}
AGENT_UID=${8:?Agent UID is required}
AGENT_GID=${9:?Agent GID is required}
STAGE=/var/tmp/echo-ai-agent-template
NODE_ROOT="/opt/node-v$NODE_VERSION-linux-x64"
PI_ROOT=/opt/echo-ai-agent/pi

die() {
  printf '[echo-ai-agent-template] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "bootstrap must run as root"
printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" "$STAGE/$NODE_ARCHIVE" \
  | sha256sum --check --status - \
  || die "Node archive checksum mismatch"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get dist-upgrade --yes
apt-get install --yes --no-install-recommends \
  ca-certificates \
  curl \
  dnsutils \
  file \
  git \
  jq \
  less \
  libnginx-mod-stream \
  nginx \
  procps \
  python3 \
  ripgrep \
  sudo \
  xz-utils
apt-get clean
rm -rf /var/lib/apt/lists/*

[[ "$AGENT_USER" == echo ]] || die "unexpected agent user"
[[ "$AGENT_UID" =~ ^[0-9]+$ && "$AGENT_GID" =~ ^[0-9]+$ ]] \
  || die "agent UID/GID must be numeric"
if getent group "$AGENT_GID" >/dev/null; then
  [[ $(getent group "$AGENT_GID" | cut -d: -f1) == "$AGENT_USER" ]] \
    || die "agent GID is owned by another group"
elif getent group "$AGENT_USER" >/dev/null; then
  die "agent group exists with a conflicting GID"
else
  groupadd --gid "$AGENT_GID" "$AGENT_USER"
fi
if getent passwd "$AGENT_UID" >/dev/null; then
  [[ $(getent passwd "$AGENT_UID" | cut -d: -f1) == "$AGENT_USER" ]] \
    || die "agent UID is owned by another user"
elif id "$AGENT_USER" >/dev/null 2>&1; then
  die "agent user exists with a conflicting UID"
else
  useradd \
    --create-home \
    --gid "$AGENT_GID" \
    --shell /bin/bash \
    --uid "$AGENT_UID" \
    "$AGENT_USER"
fi
[[ $(id -u "$AGENT_USER") == "$AGENT_UID" \
  && $(id -g "$AGENT_USER") == "$AGENT_GID" ]] \
  || die "agent user identity mismatch"
passwd --lock "$AGENT_USER" >/dev/null
install -d -m 0750 -o root -g root /etc/sudoers.d
printf 'echo ALL=(ALL:ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/echo-ai-agent
chmod 0440 /etc/sudoers.d/echo-ai-agent
visudo --check --file=/etc/sudoers.d/echo-ai-agent >/dev/null

tar -xJf "$STAGE/$NODE_ARCHIVE" -C /opt
[[ -x "$NODE_ROOT/bin/node" ]] || die "Node executable is missing"
for executable in node npm npx corepack; do
  ln -sfn "$NODE_ROOT/bin/$executable" "/usr/local/bin/$executable"
done
[[ $(node --version) == "v$NODE_VERSION" ]] || die "Node version mismatch"

install -d -m 0755 "$PI_ROOT"
install -m 0644 "$STAGE/package.json" "$STAGE/package-lock.json" "$PI_ROOT/"
printf '%s  %s\n' "$PI_TARBALL_SHA256" "$STAGE/$PI_ARCHIVE" \
  | sha256sum --check --status - \
  || die "Pi archive checksum mismatch"
npm cache add "$STAGE/$PI_ARCHIVE"
npm ci \
  --prefix "$PI_ROOT" \
  --omit=dev \
  --prefer-offline \
  --no-audit \
  --no-fund
ln -sfn "$PI_ROOT/node_modules/.bin/pi" /usr/local/bin/pi
[[ $(pi --version) == "$PI_VERSION" ]] || die "Pi version mismatch"

install -d -m 0755 /usr/local/sbin
install -m 0644 "$STAGE/runner.ts" "$PI_ROOT/runner.ts"
install -m 0755 "$STAGE/echo-ai-agent-runner" /usr/local/bin/echo-ai-agent-runner
install -m 0755 "$STAGE/configure-network.sh" \
  /usr/local/sbin/echo-ai-agent-configure-network

install -d -m 0755 /etc/nginx/modules-enabled
install -m 0644 /dev/stdin /etc/nginx/modules-enabled/99-echo-ai-agent-stream.conf <<'NGINX'
stream {
    server {
        listen 127.0.0.1:443;
        proxy_connect_timeout 10s;
        proxy_timeout 300s;
        proxy_pass 127.0.0.1:18443;
    }
}
NGINX
nginx -t
systemctl enable --now nginx

install -d -m 0755 -o "$AGENT_USER" -g "$AGENT_USER" \
  /home/echo/.pi/agent/skills/echo-read-only
install -m 0644 -o "$AGENT_USER" -g "$AGENT_USER" \
  "$STAGE/skills/echo-read-only/SKILL.md" \
  /home/echo/.pi/agent/skills/echo-read-only/SKILL.md
chown -R "$AGENT_USER:$AGENT_USER" /home/echo
find /home/echo -xdev -type d -exec chmod go-w {} +
find /home/echo -xdev -type f -exec chmod go-w {} +

systemctl mask ssh.service ssh.socket 2>/dev/null || true
rm -f /etc/ssh/ssh_host_* /root/.ssh/authorized_keys
find /var/log -type f -exec truncate -s 0 {} +
rm -f /etc/machine-id
touch /etc/machine-id
sync
