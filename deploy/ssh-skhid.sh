#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "${repo_root}/deploy/ssh-server.sh" echo-skhid-dev ssh-skhid
