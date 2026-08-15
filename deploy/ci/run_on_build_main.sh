#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

REMOTE_TARGET="${ECHO_BUILD_MAIN_SSH_TARGET:-echo-build-main}"
REMOTE_WORKDIR_RAW="${ECHO_BUILD_MAIN_WORKDIR:-~/workspace/echo}"
REMOTE_ENV_FILE=".ci-remote-env"

SSH_KEY_FILE=""
TMP_ENV_FILE=""

cleanup() {
  if [[ -n "$SSH_KEY_FILE" && -f "$SSH_KEY_FILE" ]]; then
    rm -f "$SSH_KEY_FILE"
  fi
  if [[ -n "$TMP_ENV_FILE" && -f "$TMP_ENV_FILE" ]]; then
    rm -f "$TMP_ENV_FILE"
  fi
}

trap cleanup EXIT

SSH_ARGS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
)

if [[ -n "${ECHO_BUILD_MAIN_SSH_KEY:-}" ]]; then
  SSH_KEY_FILE="$(mktemp)"
  printf '%s\n' "$ECHO_BUILD_MAIN_SSH_KEY" > "$SSH_KEY_FILE"
  chmod 600 "$SSH_KEY_FILE"
  SSH_ARGS+=(-i "$SSH_KEY_FILE")
fi

usage() {
  cat <<'EOF'
Usage:
  deploy/ci/run_on_build_main.sh sync
  deploy/ci/run_on_build_main.sh stage <stage> [args...]

Stages are executed by deploy/ci/on_build_main.sh on the remote build host.
EOF
}

join_shell_words() {
  local quoted=()
  local word=""
  for word in "$@"; do
    quoted+=("$(printf '%q' "$word")")
  done
  local IFS=' '
  printf '%s' "${quoted[*]}"
}

ssh_command_string() {
  join_shell_words ssh "${SSH_ARGS[@]}"
}

resolve_remote_workdir() {
  ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" bash -s -- "$REMOTE_WORKDIR_RAW" <<'REMOTE'
set -euo pipefail
raw="$1"

case "$raw" in
  "~")
    printf '%s\n' "$HOME"
    ;;
  "~/"*)
    printf '%s/%s\n' "$HOME" "${raw#~/}"
    ;;
  /*)
    printf '%s\n' "$raw"
    ;;
  *)
    printf '%s/%s\n' "$HOME" "$raw"
    ;;
esac
REMOTE
}

write_remote_env_file() {
  local remote_workdir="$1"
  TMP_ENV_FILE="$(mktemp)"
  : > "$TMP_ENV_FILE"

  local var_name=""
  local forwarded_vars=(
    GITHUB_ACTIONS
    GITHUB_EVENT_NAME
    GITHUB_REF
    GITHUB_REF_NAME
    GITHUB_SHA
    GITHUB_RUN_ID
    GITHUB_RUN_ATTEMPT
    GITHUB_HEAD_REF
    GITHUB_BASE_REF
    ECHO_CI_SSH_HOST
    ECHO_CI_SSH_USER
    ECHO_CI_SSH_KEY
    ECHO_CI_REPO
    ECHO_CI_DIST
    ECHO_CI_COMPONENT
    ECHO_GITHUB_PACKAGES_TOKEN
  )

  for var_name in "${forwarded_vars[@]}"; do
    if [[ -n "${!var_name+x}" ]]; then
      printf 'export %s=%q\n' "$var_name" "${!var_name}" >> "$TMP_ENV_FILE"
    fi
  done

  # wdintel-web/.npmrc reads GITHUB_TOKEN for @echoua/* on npm.pkg.github.com.
  if [[ -n "${ECHO_GITHUB_PACKAGES_TOKEN:-}" ]]; then
    printf 'export GITHUB_TOKEN=%q\n' "$ECHO_GITHUB_PACKAGES_TOKEN" >> "$TMP_ENV_FILE"
  fi

  printf 'export GITHUB_ACTIONS=%q\n' "${GITHUB_ACTIONS:-true}" >> "$TMP_ENV_FILE"
  printf 'export ECHO_BUILD_MAIN_SSH_TARGET=%q\n' "$REMOTE_TARGET" >> "$TMP_ENV_FILE"
  printf 'export ECHO_BUILD_MAIN_WORKDIR=%q\n' "$remote_workdir" >> "$TMP_ENV_FILE"

  rsync -az \
    -e "$(ssh_command_string)" \
    "$TMP_ENV_FILE" \
    "$REMOTE_TARGET:$remote_workdir/$REMOTE_ENV_FILE"
}

sync_repo() {
  local remote_workdir="$1"

  ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" "mkdir -p $(printf '%q' "$remote_workdir")"

  rsync -az --delete \
    --exclude '.git/lfs' \
    --exclude 'target' \
    --exclude 'wdintel-web/node_modules' \
    --exclude 'wdintel-rs/wdintel-py/.venv' \
    -e "$(ssh_command_string)" \
    "$REPO_ROOT/" \
    "$REMOTE_TARGET:$remote_workdir/"

  write_remote_env_file "$remote_workdir"
  echo "Synced $REPO_ROOT -> $REMOTE_TARGET:$remote_workdir"
}

run_remote_stage() {
  local remote_workdir="$1"
  shift

  write_remote_env_file "$remote_workdir"

  ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" bash -s -- "$remote_workdir" "$@" <<'REMOTE'
set -euo pipefail
remote_workdir="$1"
shift

if [[ -f "$HOME/.profile" ]]; then
  # Load host-managed PATH entries like cargo and nvm.
  . "$HOME/.profile"
fi

cd "$remote_workdir"
set -a
source ./.ci-remote-env
set +a

bash deploy/ci/on_build_main.sh "$@"
REMOTE
}

main() {
  if [[ $# -lt 1 ]]; then
    usage >&2
    exit 1
  fi

  local command="$1"
  shift

  local remote_workdir=""
  remote_workdir="$(resolve_remote_workdir)"

  case "$command" in
    sync)
      sync_repo "$remote_workdir"
      ;;
    stage)
      if [[ $# -lt 1 ]]; then
        usage >&2
        exit 1
      fi
      run_remote_stage "$remote_workdir" "$@"
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
