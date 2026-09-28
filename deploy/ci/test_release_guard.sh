#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

mkdir -p "$test_dir/deploy/ci"
cp "$SCRIPT_DIR/on_build_main.sh" "$SCRIPT_DIR/require_stable_release.sh" "$test_dir/deploy/ci/"
git -C "$test_dir" init -q
git -C "$test_dir" -c user.name=CI -c user.email=ci@example.invalid \
  -c commit.gpgsign=false commit -q --allow-empty -m fixture

export GITHUB_EVENT_NAME=push
export GITHUB_REF=refs/heads/stable
export GITHUB_SHA
GITHUB_SHA="$(git -C "$test_dir" rev-parse HEAD)"

expect_rejected() {
  local expected_message="$1"
  shift
  local output=""
  if output=$(env "$@" bash "$test_dir/deploy/ci/on_build_main.sh" "$stage" started 2>&1); then
    echo "Release stage $stage unexpectedly succeeded: $*" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    printf 'Unexpected rejection for %s: %s\n' "$stage" "$output" >&2
    exit 1
  fi
}

for stage in build-debs publish redis-mark cleanup-failure; do
  expect_rejected "require a push to stable" GITHUB_REF=refs/heads/main
  expect_rejected "require a push to stable" GITHUB_REF=refs/heads/feature
  expect_rejected "require a push to stable" GITHUB_EVENT_NAME=pull_request
  expect_rejected "require a push to stable" GITHUB_EVENT_NAME=workflow_dispatch
  expect_rejected "require a push to stable" GITHUB_EVENT_NAME=
  expect_rejected "require a push to stable" GITHUB_REF=
  expect_rejected "does not match GITHUB_SHA" GITHUB_SHA=
  expect_rejected "does not match GITHUB_SHA" GITHUB_SHA=0000000000000000000000000000000000000000
done

bash "$test_dir/deploy/ci/require_stable_release.sh"
echo "Stable release guards passed."
