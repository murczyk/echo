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

cd /home/echo/echo-debs

repo_exists() {
  local name="$1"
  aptly repo show "$name" >/dev/null 2>&1
}

drop_repo_if_exists() {
  local name="$1"
  if repo_exists "$name"; then
    aptly repo drop -force "$name" || true
  fi
}

create_repo_fresh() {
  local name="$1"
  drop_repo_if_exists "$name"
  aptly repo create -distribution="$DIST" -component="$COMP" "$name"
}

repo_package_names() {
  local name="$1"
  aptly repo show -with-packages "$name" \
    | sed -n 's/^  \([^_]*\)_.*/\1/p' \
    | sort -u
}

repo_has_pkg_name() {
  local repo_name="$1"
  local pkg_name="$2"
  [[ -n "$(aptly repo search "$repo_name" "Name (= $pkg_name)" 2>/dev/null | head -n1 || true)" ]]
}

pool_files_for_pkg_ref() {
  local pkg_ref="$1"
  # When there are duplicate packages with the same name/version/arch, aptly prints multiple entries
  # (each with its own "Files in the pool" section). We use existing pool files only.
  aptly package show -with-files "$pkg_ref" \
    | sed -n 's/^  \(\/home\/echo\/\.aptly\/pool\/.*\.deb\)$/\1/p'
}

pick_existing_pool_file_for_pkg_ref() {
  local pkg_ref="$1"
  local p
  while IFS= read -r p; do
    if [[ -f "$p" ]]; then
      echo "$p"
      return 0
    fi
  done < <(pool_files_for_pkg_ref "$pkg_ref")
  return 1
}

add_latest_pkgs_to_repo_from_repos() {
  local dst_repo="$1"
  local pkg_name="$2"
  local primary_repo="${3-}"
  local fallback_repo="${4-}"

  local added=0
  local arch=""
  local pool_file=""
  declare -A arch_added=()

  for src_repo in "$primary_repo" "$fallback_repo"; do
    [[ -n "$src_repo" ]] || continue

    while IFS= read -r pkg_ref; do
      [[ -n "$pkg_ref" ]] || continue
      arch="${pkg_ref##*_}"
      [[ -n "${arch_added["$arch"]:-}" ]] && continue

      pool_file="$(pick_existing_pool_file_for_pkg_ref "$pkg_ref")" || true
      [[ -z "$pool_file" ]] && continue

      # Keep stdout clean so callers can capture only our numeric return value.
      aptly repo add "$dst_repo" "$pool_file" 1>&2
      arch_added["$arch"]=1
      added=$((added + 1))
    done < <(aptly repo search "$src_repo" "Name (= $pkg_name)" 2>/dev/null || true)
  done

  echo "$added"
}
declare -A EXPECTED_SHA=()
declare -A EXPECTED_SIZE=()
added_basenames=()
DT="$(date -u +%Y-%m-%d-%H-%M-%S)"

# Keep a "history" repo (REPO) if it exists, but publish from a fresh "latest-only" repo each time.
# This avoids publish breakage if echo-ci pool has been manually cleaned and old package files are missing.
RUN_REPO="$REPO-run-$DT"
PUBLISH_REPO="$REPO-publish-$DT"

create_repo_fresh "$RUN_REPO"
create_repo_fresh "$PUBLISH_REPO"

for f in "$DEBS_DIR"/*.deb; do
  [[ -f "$f" ]] || continue
  bn="$(basename "$f")"
  EXPECTED_SHA["$bn"]="$(sha256sum "$f" | awk '{print $1}')"
  EXPECTED_SIZE["$bn"]="$(stat -c%s "$f")"
  aptly repo add "$RUN_REPO" "$f"
  added_basenames+=("$bn")
  rm -f -- "$f" || true
done

declare -A PKG_NAMES=()
if repo_exists "$REPO"; then
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    PKG_NAMES["$name"]=1
  done < <(repo_package_names "$REPO")
fi

while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  PKG_NAMES["$name"]=1
done < <(repo_package_names "$RUN_REPO")

for name in "${!PKG_NAMES[@]}"; do
  required=0
  if repo_has_pkg_name "$RUN_REPO" "$name"; then
    required=1
  fi

  added="$(add_latest_pkgs_to_repo_from_repos "$PUBLISH_REPO" "$name" "$RUN_REPO" "$REPO")"
  if [[ "$added" -eq 0 ]]; then
    if [[ "$required" -eq 1 ]]; then
      echo "::error::failed to add any packages for '$name' (present in run repo '$RUN_REPO'); echo-ci pool may be incomplete" >&2
      exit 1
    else
      echo "::warning::skipping '$name': no existing pool .deb files found in '$REPO' (echo-ci pool may be incomplete)" >&2
    fi
  fi
done

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
create_snapshot_if_missing "$SNAP_REPO" from repo "$PUBLISH_REPO"

SNAP_TO_PUBLISH="$SNAP_REPO"
MERGE_LIST=("$SNAP_REPO")

if aptly repo show echo-install-utils >/dev/null 2>&1; then
  # Publish only the latest version of each package from echo-install-utils as well (pool may have been cleaned).
  UTILS_RUN_REPO="echo-install-utils-publish-$DT"
  create_repo_fresh "$UTILS_RUN_REPO"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    added="$(add_latest_pkgs_to_repo_from_repos "$UTILS_RUN_REPO" "$name" "echo-install-utils")"
    if [[ "$added" -eq 0 ]]; then
      echo "::warning::skipping echo-install-utils '$name': no existing pool .deb files found (pool may be incomplete)" >&2
    fi
  done < <(repo_package_names echo-install-utils)

  SNAP_UTILS="echo-install-utils-$DT"
  create_snapshot_if_missing "$SNAP_UTILS" from repo "$UTILS_RUN_REPO"
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
    # aptly may publish pool files with a hash prefix (e.g. "<hash>_<filename>.deb").
    publish_path="$(find "$HOME/.aptly/public/$REPO/pool" -type f \
      \( -name "$bn" -o -name "*_$bn" \) -print -quit || true)"
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

# Success cleanup: keep snapshots, but drop temporary repos created during this run.
drop_repo_if_exists "$RUN_REPO"
drop_repo_if_exists "$PUBLISH_REPO"
if [[ -n "${UTILS_RUN_REPO:-}" ]]; then
  drop_repo_if_exists "$UTILS_RUN_REPO"
fi

ls -lah "$HOME/.aptly/public/$REPO/dists/$DIST" || true
REMOTE

echo "Published to echo-ci ($ECHO_CI_SSH_HOST)"
