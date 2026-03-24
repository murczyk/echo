#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'EOF'
Usage:
  deploy/ci/on_build_main.sh run-tests
  deploy/ci/on_build_main.sh build-debs
  deploy/ci/on_build_main.sh publish
  deploy/ci/on_build_main.sh redis-mark started|finished
  deploy/ci/on_build_main.sh cleanup-failure
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command on echo-build-main: $command_name" >&2
    exit 1
  fi
}

require_commands() {
  local command_name=""
  for command_name in "$@"; do
    require_command "$command_name"
  done
}

restore_local_caches() {
  ./scripts/cache/restore-npm.sh || true
  ./scripts/cache/restore-python.sh || true
  ./scripts/cache/restore-spacy.sh || true
}

run_tests() {
  require_commands cargo curl git just node npm psql rsync tq
  restore_local_caches
  export GITHUB_ACTIONS="${GITHUB_ACTIONS:-true}"
  bash deploy/run_ci_tests.sh
}

build_debs() {
  require_commands cargo file git node npm
  export GITHUB_ACTIONS="${GITHUB_ACTIONS:-true}"
  bash deploy/ci/build_debs.sh
}

publish() {
  require_commands scp ssh
  bash deploy/ci/publish_echo_ci.sh
}

redis_mark() {
  local action="${1:-}"
  if [[ "$action" != "started" && "$action" != "finished" ]]; then
    usage >&2
    exit 1
  fi
  require_commands redis-cli tq
  bash deploy/ci/redis_mark_deploy.sh "$action"
}

cleanup_failure() {
  rm -rf target/debian || true
}

main() {
  local command="${1:-}"
  shift || true

  case "$command" in
    run-tests)
      run_tests
      ;;
    build-debs)
      build_debs
      ;;
    publish)
      publish
      ;;
    redis-mark)
      redis_mark "$@"
      ;;
    cleanup-failure)
      cleanup_failure
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
