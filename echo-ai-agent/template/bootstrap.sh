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
  fonts-dejavu-core \
  git \
  jq \
  less \
  libnginx-mod-stream \
  nginx \
  procps \
  python3 \
  python3-docx \
  python3-lxml \
  python3-matplotlib \
  python3-openpyxl \
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
install -m 0644 "$STAGE/context-compaction.ts" "$PI_ROOT/context-compaction.ts"
install -m 0644 "$STAGE/work-memory.ts" "$PI_ROOT/work-memory.ts"
install -m 0644 "$STAGE/execution-policy.ts" "$PI_ROOT/execution-policy.ts"
install -m 0644 "$STAGE/flash-research.ts" "$PI_ROOT/flash-research.ts"
install -m 0644 "$STAGE/citations.ts" "$PI_ROOT/citations.ts"
install -m 0644 "$STAGE/attachments.ts" "$PI_ROOT/attachments.ts"
install -m 0644 "$STAGE/uploads.ts" "$PI_ROOT/uploads.ts"
install -m 0644 "$STAGE/devices.ts" "$PI_ROOT/devices.ts"
install -m 0644 "$STAGE/maps.ts" "$PI_ROOT/maps.ts"
install -m 0644 "$STAGE/map-script.ts" "$PI_ROOT/map-script.ts"
install -m 0644 "$STAGE/python-sandbox.ts" "$PI_ROOT/python-sandbox.ts"
install -m 0644 "$STAGE/documents.ts" "$PI_ROOT/documents.ts"
install -m 0644 "$STAGE/sidc-resolver.ts" "$PI_ROOT/sidc-resolver.ts"
install -m 0644 "$STAGE/group-scope.ts" "$PI_ROOT/group-scope.ts"
install -m 0644 "$STAGE/search-guidance.ts" "$PI_ROOT/search-guidance.ts"
node --experimental-strip-types --input-type=module \
  -e "await import('file://$PI_ROOT/runner.ts')"
install -m 0755 "$STAGE/echo-ai-agent-runner" /usr/local/bin/echo-ai-agent-runner
# Map-script library; the runner executes it in user+network namespaces.
install -d -m 0755 /opt/echo-ai-agent/python/echomap
install -m 0644 "$STAGE"/python/echomap/*.py "$STAGE/python/echomap/app6d-catalog.json" \
  /opt/echo-ai-agent/python/echomap/
# Shared sandbox hardening and the document-script library (python-docx).
install -m 0644 "$STAGE/python/echosandbox.py" /opt/echo-ai-agent/python/echosandbox.py
install -d -m 0755 /opt/echo-ai-agent/python/echodoc
install -m 0644 "$STAGE"/python/echodoc/*.py /opt/echo-ai-agent/python/echodoc/
runuser -u "$AGENT_USER" -- unshare --user --map-root-user --net -- true \
  || printf '[echo-ai-agent-template] WARNING: no unprivileged namespaces; map and document scripts disabled\n' >&2
python3 -I -c 'import docx, matplotlib; print("python-docx", getattr(docx, "__version__", "unknown"))' \
  || printf '[echo-ai-agent-template] WARNING: python-docx or matplotlib unavailable; document scripts will fail\n' >&2
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
