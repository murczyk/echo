#!/usr/bin/env bash
set -euxo pipefail

# Publish built .deb packages to an echo-ci server running aptly.
# Mirrors the signed publish flow used by echo-install-utils / echo-gpu / echo-operator.
#
# Required env (via GitHub secrets or local env):
#   ECHO_CI_SSH_HOST, ECHO_CI_SSH_USER, ECHO_CI_SSH_KEY (PEM content)
# Optional overrides:
#   ECHO_CI_REPO (default: echo)
#   ECHO_CI_DIST (default: jammy)
#   ECHO_CI_COMPONENT (default: main)
# Optional signing vars (if set, publishing is signed):
#   ECHO_CI_GPG_KEYID           GPG key id to sign with
#   ECHO_CI_GPG_PASSPHRASE_FILE Path to passphrase file on echo-ci host
#   ECHO_CI_GPG_PROVIDER        gpg provider (e.g. gpg, gpg2)

: "${ECHO_CI_REPO:=echo}"
: "${ECHO_CI_DIST:=jammy}"
: "${ECHO_CI_COMPONENT:=main}"
: "${ECHO_CI_SSH_HOST:=echo-ci.eagle-atria.ts.net}"
: "${ECHO_CI_SSH_USER:=echo}"
GPG_KEYID="${ECHO_CI_GPG_KEYID:-}"
GPG_PASS_FILE="${ECHO_CI_GPG_PASSPHRASE_FILE:-}"
GPG_PROVIDER="${ECHO_CI_GPG_PROVIDER:-}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if ! compgen -G "target/debian/*.deb" > /dev/null; then
  echo "No .deb files found in target/debian; did you run deploy/ci/build_debs.sh?" >&2
  exit 1
fi

mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keyscan -H "$ECHO_CI_SSH_HOST" >> ~/.ssh/known_hosts 2>/dev/null || true

SSH_IDENTITY_ARGS=()
if [[ -n "${ECHO_CI_SSH_KEY:-}" ]]; then
  echo "$ECHO_CI_SSH_KEY" > ~/.ssh/echo_ci
  chmod 600 ~/.ssh/echo_ci
  SSH_IDENTITY_ARGS=(-i ~/.ssh/echo_ci)
fi

DEBS_DIR_REMOTE="/home/echo/echo-debs/$ECHO_CI_REPO"

retries=3
connected=0
for attempt in $(seq 1 $retries); do
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_IDENTITY_ARGS[@]}" \
    "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" true 2>/dev/null; then
    connected=1
    break
  fi
  echo "warn: SSH attempt $attempt/$retries to $ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST failed" >&2
  sleep 2
done

if [[ $connected -eq 0 ]]; then
  echo "::error::echo-ci publish failed: cannot SSH to $ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" >&2
  exit 1
fi

ssh "${SSH_IDENTITY_ARGS[@]}" "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" "mkdir -p \"$DEBS_DIR_REMOTE\""
scp "${SSH_IDENTITY_ARGS[@]}" target/debian/*.deb "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST:$DEBS_DIR_REMOTE/"

ssh "${SSH_IDENTITY_ARGS[@]}" "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" bash -s -- \
  "$ECHO_CI_REPO" "$ECHO_CI_DIST" "$ECHO_CI_COMPONENT" "$DEBS_DIR_REMOTE" "$GPG_KEYID" "$GPG_PASS_FILE" "$GPG_PROVIDER" <<'REMOTE'
set -euxo pipefail
REPO="$1"
DIST="$2"
COMP="$3"
DEBS_DIR="$4"
GPG_KEYID="${5-}"
GPG_PASS_FILE="${6-}"
GPG_PROVIDER="${7-}"

aptly repo show "$REPO" >/dev/null 2>&1 || \
  aptly repo create -distribution="$DIST" -component="$COMP" "$REPO"

cd /home/echo/echo-debs
deb_packages_identical() {
  local deb_a="$1"
  local deb_b="$2"
  local data_a data_b ctrl_a ctrl_b status
  data_a=$(mktemp -d)
  data_b=$(mktemp -d)
  ctrl_a=$(mktemp -d)
  ctrl_b=$(mktemp -d)
  status=1
  if dpkg-deb -x "$deb_a" "$data_a" && dpkg-deb -x "$deb_b" "$data_b" \
    && dpkg-deb -e "$deb_a" "$ctrl_a" && dpkg-deb -e "$deb_b" "$ctrl_b"; then
    if diff -qr "$data_a" "$data_b" >/dev/null \
      && diff -qr "$ctrl_a" "$ctrl_b" >/dev/null; then
      status=0
    fi
  fi
  rm -rf "$data_a" "$data_b" "$ctrl_a" "$ctrl_b"
  return $status
}
declare -A EXPECTED_SHA=()
declare -A EXPECTED_SIZE=()
added_basenames=()
for f in "$REPO"/*.deb; do
  if [[ -f "$f" ]]; then
    bn=$(basename "$f")
    EXPECTED_SHA["$bn"]=$(sha256sum "$f" | awk '{print $1}')
    EXPECTED_SIZE["$bn"]=$(stat -c%s "$f")
    if add_output=$(aptly repo add "$REPO" "$f" 2>&1); then
      added_basenames+=("$bn")
    else
      publish_path=$(find "$HOME/.aptly/public/$REPO/pool" -name "$bn" -type f -print -quit || true)
      if [[ -z "$publish_path" ]]; then
        publish_path=$(find "$HOME/.aptly/pool" -name "$bn" -type f -print -quit || true)
      fi
      if [[ -n "$publish_path" ]]; then
        actual_sha=$(sha256sum "$publish_path" | awk '{print $1}')
        actual_size=$(stat -c%s "$publish_path")
        if [[ "$actual_sha" == "${EXPECTED_SHA["$bn"]}" && "$actual_size" == "${EXPECTED_SIZE["$bn"]}" ]]; then
          EXPECTED_SHA["$bn"]="$actual_sha"
          EXPECTED_SIZE["$bn"]="$actual_size"
          echo "::notice::$bn already exists in $REPO with identical contents; skipping add"
          added_basenames+=("$bn")
        elif deb_packages_identical "$f" "$publish_path"; then
          EXPECTED_SHA["$bn"]="$actual_sha"
          EXPECTED_SIZE["$bn"]="$actual_size"
          echo "::notice::$bn already exists in $REPO; payload matches after extraction so skipping add"
          added_basenames+=("$bn")
        else
          echo "$add_output" >&2
          echo "::notice::$bn already exists in $REPO with different contents; leaving published artifact untouched and skipping upload" >&2
        fi
      else
        echo "$add_output" >&2
        echo "::error::failed to add package $bn to repo $REPO and no existing published file was found" >&2
        rm -f -- "$f" || true
        exit 1
      fi
    fi
    rm -f -- "$f" || true
  fi
done

DT="$(date -u +%Y-%m-%d-%H-%M-%S)"

snapshot_exists() {
  local name="$1"
  aptly snapshot show "$name" >/dev/null 2>&1
}

create_snapshot_if_missing() {
  local name="$1"; shift
  if snapshot_exists "$name"; then
    echo "::notice::snapshot '$name' already exists; reusing"
    return 0
  fi
  if ! aptly snapshot create "$name" "$@"; then
    if snapshot_exists "$name"; then
      echo "::notice::snapshot '$name' appeared during create; reusing"
      return 0
    fi
    echo "::error::failed to create snapshot '$name' and it does not exist" >&2
    return 1
  fi
}

SNAP_REPO="$REPO-$DT"
create_snapshot_if_missing "$SNAP_REPO" from repo "$REPO"

SNAP_TO_PUBLISH="$SNAP_REPO"
MERGE_LIST=("$SNAP_REPO")

if aptly repo show echo-install-utils >/dev/null 2>&1; then
  SNAP_UTILS="echo-install-utils-$DT"
  create_snapshot_if_missing "$SNAP_UTILS" from repo echo-install-utils
  MERGE_LIST+=("$SNAP_UTILS")
fi

if (( ${#MERGE_LIST[@]} > 1 )); then
  MERGED="$REPO-$DT-merged"
  if snapshot_exists "$MERGED"; then
    echo "::notice::merged snapshot '$MERGED' already exists; reusing"
  else
    aptly snapshot merge -latest "$MERGED" "${MERGE_LIST[@]}"
  fi
  SNAP_TO_PUBLISH="$MERGED"
fi

ABH=
if aptly publish switch -help 2>&1 | grep -q 'acquire-by-hash'; then
  ABH='-acquire-by-hash'
fi

if [[ -n "$GPG_KEYID" ]]; then
  SIGN_ARGS=(-batch $ABH -gpg-key "$GPG_KEYID")
  [[ -n "$GPG_PASS_FILE" ]] && SIGN_ARGS+=( -passphrase-file "$GPG_PASS_FILE" )
  [[ -n "$GPG_PROVIDER" ]] && SIGN_ARGS+=( -gpg-provider "$GPG_PROVIDER" )
  mkdir -p "$HOME/.aptly/public/keys"
  gpg --armor --export "$GPG_KEYID" > "$HOME/.aptly/public/keys/echo-ci-archive-keyring.asc" || true
  gpg --export "$GPG_KEYID" > "$HOME/.aptly/public/keys/echo-ci-archive-keyring.gpg" || true
else
  SIGN_ARGS=(-skip-signing $ABH)
fi

echo "$SNAP_TO_PUBLISH" > "$DEBS_DIR/$REPO.LAST_SNAPSHOT" || true
echo "$SNAP_TO_PUBLISH" > "$HOME/.aptly/${REPO}.LAST_SNAPSHOT" || true

if ! aptly publish switch -force-overwrite "${SIGN_ARGS[@]}" "$DIST" "$REPO" "$SNAP_TO_PUBLISH"; then
  echo "Publish switch failed, attempting drop+publish..."
  aptly publish drop -force-drop "$DIST" "$REPO" || true
  aptly publish snapshot -force-overwrite "${SIGN_ARGS[@]}" -component="$COMP" -distribution="$DIST" "$SNAP_TO_PUBLISH" "$REPO"
fi

if ((${#added_basenames[@]} > 0)); then
  for bn in "${added_basenames[@]}"; do
    expected_sha=${EXPECTED_SHA["$bn"]}
    expected_size=${EXPECTED_SIZE["$bn"]}
    if [[ -z "$expected_sha" || -z "$expected_size" ]]; then
      echo "::error::missing expected metadata for $bn" >&2
      exit 1
    fi
    publish_path=$(find "$HOME/.aptly/public/$REPO/pool" -name "$bn" -type f -print -quit || true)
    if [[ -z "$publish_path" ]]; then
      echo "::error::published file $bn not found under public/$REPO/pool" >&2
      exit 1
    fi
    actual_sha=$(sha256sum "$publish_path" | awk '{print $1}')
    actual_size=$(stat -c%s "$publish_path")
    if [[ "$actual_sha" != "$expected_sha" || "$actual_size" != "$expected_size" ]]; then
      echo "::error::published file mismatch for $bn: expected $expected_sha ($expected_size bytes) got $actual_sha ($actual_size bytes)" >&2
      exit 1
    fi
  done
fi

ls -lah "$HOME/.aptly/public/$REPO/dists/$DIST" || true
REMOTE

echo "Published to echo-ci ($ECHO_CI_SSH_HOST)"
