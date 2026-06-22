#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  exit 0
fi

cat >&2 <<'EOF'
ERROR: GITHUB_TOKEN is not set; cannot install @echoua/* from npm.pkg.github.com.

CI: add repository secret ECHO_GITHUB_PACKAGES_TOKEN
     (echoua/echo → Settings → Secrets and variables → Actions)
     with a classic PAT that has read:packages (+ repo if the package is private).

The workflow forwards that secret to echo-build-main as GITHUB_TOKEN for npm ci.
The default github.token is usually insufficient when the package is published from another repo.

Local: export GITHUB_TOKEN=ghp_... before npm ci (see README-NEWCOMERS.md).
EOF
exit 1
