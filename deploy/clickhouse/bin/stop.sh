#!/usr/bin/env bash

set -euo pipefail

# PostgreSQL stays up so the app receives a fast query error and falls back.
sudo systemctl stop echo-analytics.target
sudo systemctl stop clickhouse-server.service
