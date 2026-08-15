#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
install_root=/opt/echo-vllm-worker
config_root=/etc/echo-vllm-worker
snapshot=/var/lib/echo-vllm-worker/huggingface/hub/models--numind--NuExtract3/snapshots/2e9fca82ee641e6bb6e1f5d905241e994be27a07

[[ $EUID -eq 0 ]] || {
  printf 'install.sh must run as root inside the dedicated production container\n' >&2
  exit 1
}
[[ -d "$snapshot" ]]
[[ $(/opt/vllm-venv/bin/python -c 'import vllm; print(vllm.__version__)') == 0.26.0 ]]
command -v gcc >/dev/null
command -v tailscale >/dev/null
[[ -f /usr/include/python3.13/Python.h ]]
systemctl is-enabled --quiet tailscaled.service
systemctl is-active --quiet tailscaled.service
[[ $(tailscale ip -4) == 100.113.47.83 ]]
getent group video >/dev/null
getent group render >/dev/null

getent group echo-vllm-worker >/dev/null || /usr/sbin/groupadd --system echo-vllm-worker
if ! getent passwd echo-vllm-worker >/dev/null; then
  /usr/sbin/useradd \
    --system \
    --gid echo-vllm-worker \
    --groups video,render \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    echo-vllm-worker
fi
[[ $(id -gn echo-vllm-worker) == echo-vllm-worker ]]
/usr/sbin/usermod --append --groups video,render echo-vllm-worker

install -d -m 0755 "$install_root/bin" "$config_root"
install -m 0755 "$SCRIPT_DIR/run-worker.sh" "$install_root/bin/run-nuextract"
install -m 0644 "$SCRIPT_DIR/runtime.env" "$config_root/nuextract.env"
install -m 0755 "$SCRIPT_DIR/verify.sh" "$install_root/bin/verify-nuextract"
install -m 0644 \
  "$SCRIPT_DIR/echo-vllm-worker-nuextract.service" \
  /etc/systemd/system/echo-vllm-worker-nuextract.service
chown -R echo-vllm-worker:echo-vllm-worker /var/lib/echo-vllm-worker
systemd-analyze verify /etc/systemd/system/echo-vllm-worker-nuextract.service
systemctl daemon-reload
systemctl enable echo-vllm-worker-nuextract.service
systemctl restart echo-vllm-worker-nuextract.service

for _ in $(seq 1 360); do
  if curl -fs --max-time 10 http://100.113.47.83:8000/health >/dev/null; then
    break
  fi
  if ! systemctl is-active --quiet echo-vllm-worker-nuextract.service; then
    journalctl -u echo-vllm-worker-nuextract.service --no-pager -n 240
    exit 1
  fi
  sleep 5
done
"$install_root/bin/verify-nuextract"
