#!/usr/bin/env bash
set -euo pipefail

if [[ -f "$HOME/.profile" ]]; then
  # Load host-managed PATH entries like cargo and nvm.
  . "$HOME/.profile"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
TEST_REAP_GRACE_SECS=3
# Lives in target/ because the checkout sync deletes untracked files elsewhere.
TEST_RUN_FILE="target/ci-test-run"
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
  deploy/ci/on_build_main.sh reap-tests
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

save_local_caches() {
  ./scripts/cache/save-npm.sh || true
  ./scripts/cache/save-pip.sh || true
  ./scripts/cache/save-python.sh || true
  ./scripts/cache/save-spacy.sh || true
}

run_test_pids() {
  local run_name="$1"
  local environ_file=""
  local pid=""
  for environ_file in /proc/[0-9]*/environ; do
    pid="${environ_file#/proc/}"
    pid="${pid%/environ}"
    # redis-server overwrites its environment with its title, so it is found
    # by the working directory the shard runner gave it.
    if grep -qszxF "ECHO_CI_RUN=$run_name" "$environ_file" \
      || [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "/dev/shm/echo-ci-$run_name/"* ]]; then
      printf '%s\n' "$pid"
    fi
  done
}

signal_run_tests() {
  local signal_name="$1"
  local run_name="$2"
  local pids=()
  mapfile -t pids < <(run_test_pids "$run_name")
  if (( ${#pids[@]} > 0 )); then
    echo "Sending $signal_name to ${#pids[@]} leftover test processes"
    kill "-$signal_name" "${pids[@]}" 2>/dev/null || true
  fi
}

# The remote shell gets no hangup when a cancelled job kills its SSH client, so
# neither traps nor Python cleanup run. Everything a test run starts inherits its
# ECHO_CI_RUN, and only that recorded run's processes and directories are touched.
reap_tests() {
  [[ -f "$TEST_RUN_FILE" ]] || return 0
  local run_name=""
  run_name="$(<"$TEST_RUN_FILE")"
  [[ -n "$run_name" ]] || return 0
  signal_run_tests TERM "$run_name"
  sleep "$TEST_REAP_GRACE_SECS"
  signal_run_tests KILL "$run_name"
  rm -rf -- "/dev/shm/echo-ci-$run_name" "/tmp/echo-ci-$run_name" \
    "/tmp/echo-device-audio.$run_name-"*
  rm -f -- "$TEST_RUN_FILE"
}

run_tests() {
  require_commands cargo curl git just node npm psql redis-server rsync tq
  reap_tests
  export ECHO_CI_RUN="${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
  mkdir -p "$(dirname "$TEST_RUN_FILE")"
  printf '%s\n' "$ECHO_CI_RUN" > "$TEST_RUN_FILE"
  export GITHUB_ACTIONS="${GITHUB_ACTIONS:-true}"
  # node_modules and .venv persist on this host, guarded by their own install checks.
  bash deploy/run_ci_tests.sh
}

build_debs() {
  require_commands cargo file git just node npm
  export GITHUB_ACTIONS="${GITHUB_ACTIONS:-true}"
  just prepare-workspace
  bash deploy/ci/build_debs.sh
  save_local_caches
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
    build-debs|publish|redis-mark|cleanup-failure)
      bash "$SCRIPT_DIR/require_stable_release.sh"
      ;;
  esac

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
    reap-tests)
      reap_tests
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
