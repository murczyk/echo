#!/usr/bin/env bash
set -euo pipefail

: "${ECHO_CI_REPO:=echo}"
: "${ECHO_CI_DIST:=jammy}"
: "${ECHO_CI_COMPONENT:=main}"
: "${ECHO_CI_SSH_HOST:=echo-ci.eagle-atria.ts.net}"
: "${ECHO_CI_SSH_USER:=echo}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

shopt -s nullglob
deb_files=(target/debian/*.deb)
shopt -u nullglob
if [[ "${#deb_files[@]}" -eq 0 ]]; then
  echo "No .deb files found in target/debian; did you run deploy/ci/build_debs.sh?" >&2
  exit 1
fi

mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keyscan -H "$ECHO_CI_SSH_HOST" >> ~/.ssh/known_hosts 2>/dev/null || true

SSH_KEY_FILE=""
cleanup() {
  if [[ -n "$SSH_KEY_FILE" && -f "$SSH_KEY_FILE" ]]; then
    rm -f "$SSH_KEY_FILE"
  fi
}
trap cleanup EXIT

SSH_IDENTITY_ARGS=()
if [[ -n "${ECHO_CI_SSH_KEY:-}" ]]; then
  SSH_KEY_FILE="$(mktemp)"
  printf '%s\n' "$ECHO_CI_SSH_KEY" > "$SSH_KEY_FILE"
  chmod 600 "$SSH_KEY_FILE"
  SSH_IDENTITY_ARGS=(-i "$SSH_KEY_FILE")
fi

join_shell_words() {
  local quoted=()
  local word=""
  for word in "$@"; do
    quoted+=("$(printf '%q' "$word")")
  done
  local IFS=' '
  printf '%s' "${quoted[*]}"
}

ssh_echo_ci() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 \
    "${SSH_IDENTITY_ARGS[@]}" \
    "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" "$@"
}

for attempt in 1 2 3; do
  if ssh_echo_ci true 2>/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 3 ]]; then
    echo "::error::echo-ci publish failed: cannot SSH to $ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" >&2
    exit 1
  fi
  sleep 2
done

remote_dir="/home/echo/echo-debs/$ECHO_CI_REPO"
ssh_echo_ci "$(join_shell_words mkdir -p "$remote_dir")"
scp "${SSH_IDENTITY_ARGS[@]}" "${deb_files[@]}" \
  "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST:$remote_dir/"

publish_args=(
  /usr/bin/echo-install-utils publish-deb
  --repo "$ECHO_CI_REPO"
  --distribution "$ECHO_CI_DIST"
  --component "$ECHO_CI_COMPONENT"
)
for deb_file in "${deb_files[@]}"; do
  publish_args+=(--deb-path "$remote_dir/$(basename "$deb_file")")
done

if ! publish_output="$(ssh_echo_ci "$(join_shell_words "${publish_args[@]}")" 2>&1)"; then
  printf '%s\n' "$publish_output" >&2
  if [[ "$publish_output" == *"already exists with different content"* ]]; then
    echo "::warning::Debian package version already published; keeping the existing package."
    exit 0
  fi
  exit 1
fi

printf '%s\n' "$publish_output"

echo "Published ${#deb_files[@]} package(s) to echo-ci repo $ECHO_CI_REPO"
