#!/bin/bash
set -euxo pipefail
export PATH="$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"

cd "$SCRIPT_DIR"

if ! command -v pip > /dev/null 2>&1; then
    sudo apt-get -y update && sudo apt-get -y install python3-pip
fi

if ! command -v uv > /dev/null 2>&1; then
    pip install --user uv
fi

if ! command -v mlflow > /dev/null 2>&1; then
    uv tool install mlflow
fi

install -D -m 0644 systemd/mlflow.service "$HOME/.config/systemd/user/mlflow.service"
install -D -m 0644 systemd/mlflow-gc.service "$HOME/.config/systemd/user/mlflow-gc.service"
install -D -m 0644 systemd/mlflow-gc.timer "$HOME/.config/systemd/user/mlflow-gc.timer"
systemctl --user daemon-reload
sudo loginctl enable-linger "$(id -u -n)"
systemctl --user enable --now mlflow.service mlflow-gc.timer
systemctl --user restart mlflow.service
