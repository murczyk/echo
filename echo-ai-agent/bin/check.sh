#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

require_cmd jq
require_cmd node
require_cmd npm
require_cmd python3
require_cmd sha256sum
validate_bundle
grep -Fq "namespace_file=\"\$DISPATCH_NAMESPACE_DIR/\$dispatcher_user\"" \
  "$BUNDLE_DIR/bin/force-command.sh" \
  || die "forced command does not use the managed namespace mapping"
grep -Fq /usr/local/libexec/echo-ai-agent-prepare-dispatcher-homes \
  "$BUNDLE_DIR/systemd/echo-ai-agent-sshd.service" \
  || die "dispatcher service does not prepare isolated runtime homes"

test_root=
cleanup() {
  if [[ -n "$test_root" && "$test_root" =~ ^/tmp/echo-ai-agent-check\.[A-Za-z0-9]+$ ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

while IFS= read -r script; do bash -n "$script"; done \
  < <(find "$BUNDLE_DIR" -type f -name '*.sh' -o -path "$BUNDLE_DIR/runner/echo-ai-agent-runner" | sort)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s "$BUNDLE_DIR/tests" -p 'test_*.py'
bash "$BUNDLE_DIR/tests/test-partition-table.sh"
bash "$BUNDLE_DIR/tests/test-incus-metadata.sh"
bash "$BUNDLE_DIR/tests/test-lvm-layout.sh"
bash "$BUNDLE_DIR/tests/test-server-target.sh"
bash "$BUNDLE_DIR/tests/test-dispatcher-identity.sh"
node --experimental-strip-types --check "$BUNDLE_DIR/runner/runner.ts"
test_root=$(mktemp -d /tmp/echo-ai-agent-check.XXXXXX)
cp "$BUNDLE_DIR/package.json" "$BUNDLE_DIR/package-lock.json" "$test_root/"
cp -a "$BUNDLE_DIR/runner" "$test_root/runner"
npm ci --prefix "$test_root" --ignore-scripts --no-audit --no-fund
npm test --prefix "$test_root"
if command -v shellcheck >/dev/null 2>&1; then
  mapfile -t shell_scripts < <(find "$BUNDLE_DIR" -type f -name '*.sh' | sort)
  shellcheck "${shell_scripts[@]}" "$BUNDLE_DIR/runner/echo-ai-agent-runner"
fi
printf '[echo-ai-agent] local checks passed\n'
