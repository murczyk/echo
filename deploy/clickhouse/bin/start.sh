#!/usr/bin/env bash

set -euo pipefail

sudo systemctl start postgresql@18-main.service clickhouse-server.service
sudo systemctl start echo-analytics.target
