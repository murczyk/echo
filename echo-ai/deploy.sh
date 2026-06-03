#!/bin/bash
set -euxo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$HOME/echo-ai"

if ! command -v uv > /dev/null 2>&1; then
    if ! command -v pipx > /dev/null 2>&1; then
        sudo apt-get -y update && sudo apt-get -y install python3-pip pipx
    fi
    pipx install uv
fi

if ! command -v mlflow > /dev/null 2>&1; then
    uv tool install 'mlflow>=3.8.1'
fi

install -D -m 0644 -t "$HOME/.config/systemd/user" systemd/*
systemctl --user daemon-reload
sudo loginctl enable-linger "$(id -u -n)"
systemctl --user enable mlflow.service
systemctl --user enable --now mlflow-gc.timer echo-ai-train.timer
systemctl --user restart mlflow.service
