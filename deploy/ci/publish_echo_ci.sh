#!/usr/bin/env bash
set -euo pipefail

# Publish built .deb packages to an echo-ci server running aptly.
#
# Required env (via GitHub secrets or local env):
#   ECHO_CI_SSH_HOST, ECHO_CI_SSH_USER, ECHO_CI_SSH_KEY (PEM content)
# Optional overrides:
#   ECHO_CI_REPO (default: echo)
#   ECHO_CI_DIST (default: jammy)
#   ECHO_CI_COMPONENT (default: main)

: "${ECHO_CI_REPO:=echo}"
: "${ECHO_CI_DIST:=jammy}"
: "${ECHO_CI_COMPONENT:=main}"

: "${ECHO_CI_SSH_HOST:=echo-ci.eagle-atria.ts.net}"
: "${ECHO_CI_SSH_USER:=echo}"

# Prepare SSH options
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keyscan -H "$ECHO_CI_SSH_HOST" >> ~/.ssh/known_hosts 2>/dev/null || true

SSH_IDENTITY_ARGS=()
if [[ -n "${ECHO_CI_SSH_KEY:-}" ]]; then
  echo "$ECHO_CI_SSH_KEY" > ~/.ssh/echo_ci
  chmod 600 ~/.ssh/echo_ci
  SSH_IDENTITY_ARGS=(-i ~/.ssh/echo_ci)
fi

# Use the shared echo-ci layout like echo-install-utils/echo-gpu
DEBS_DIR_REMOTE="/home/echo/echo-debs/$ECHO_CI_REPO"

# Quick connectivity probe with small retry; fail the job on inability to reach CI
retries=3
for attempt in $(seq 1 $retries); do
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "${SSH_IDENTITY_ARGS[@]}" \
    "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" true 2>/dev/null; then
    break
  fi
  echo "warn: SSH attempt $attempt/$retries to $ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST failed" >&2
  sleep 2
  if [[ $attempt -eq $retries ]]; then
    echo "::error::echo-ci publish failed: cannot SSH to $ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" >&2
    exit 1
  fi
done

# Upload debs
ssh "${SSH_IDENTITY_ARGS[@]}" "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" "mkdir -p \"$DEBS_DIR_REMOTE\""
scp "${SSH_IDENTITY_ARGS[@]}" target/debian/*.deb "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST:$DEBS_DIR_REMOTE/"

# Trigger aptly import + publish remotely
ssh "${SSH_IDENTITY_ARGS[@]}" "$ECHO_CI_SSH_USER@$ECHO_CI_SSH_HOST" bash -s -- \
  "$ECHO_CI_REPO" "$ECHO_CI_DIST" "$ECHO_CI_COMPONENT" "$DEBS_DIR_REMOTE" <<'REMOTE'
set -euo pipefail
REPO="$1"; DIST="$2"; COMP="$3"; DEBS_DIR="$4"

# Initialize aptly repo if missing
if ! aptly repo show "$REPO" >/dev/null 2>&1; then
  aptly repo create -distribution="$DIST" -component="$COMP" "$REPO"
fi

# Import debs
aptly repo add -force-replace=true "$REPO" "$DEBS_DIR"/*.deb

# Create timestamped snapshot of this repo
DT=$(date -u +%Y%m%d%H%M%S)
SNAP_REPO="$REPO-$DT"
MERGED="$REPO-merged-$DT"
aptly snapshot create "$SNAP_REPO" from repo "$REPO"

# If echo-install-utils repo exists, merge its snapshot into this snapshot
if aptly repo show echo-install-utils >/dev/null 2>&1; then
  SNAP_UTILS="echo-install-utils-$DT"
  aptly snapshot create "$SNAP_UTILS" from repo echo-install-utils
  # -latest to prefer latest versions on conflicts
  aptly snapshot merge -latest "$MERGED" "$SNAP_REPO" "$SNAP_UTILS"
  SNAP_TO_PUBLISH="$MERGED"
else
  SNAP_TO_PUBLISH="$SNAP_REPO"
fi

echo "Snapshot to publish: $SNAP_TO_PUBLISH"
echo "Preview packages in snapshot (first 40 lines):"
aptly snapshot show -with-packages "$SNAP_TO_PUBLISH" | sed -n '1,40p' || true

# Save a marker with the last snapshot name for troubleshooting
echo "$SNAP_TO_PUBLISH" > "$DEBS_DIR/$REPO.LAST_SNAPSHOT" || true

# publish under prefix "$REPO" (e.g., /echo), switching to new (possibly merged) snapshot
# Try switch first (robust if already published), then fallback to drop+publish snapshot.
if ! aptly publish switch -skip-signing "$DIST" "$REPO" "$SNAP_TO_PUBLISH"; then
  echo "Publish switch failed, attempting drop+publish..."
  aptly publish drop -force-drop "$DIST" "$REPO" || true
  aptly publish snapshot -skip-signing -component="$COMP" -distribution="$DIST" "$SNAP_TO_PUBLISH" "$REPO"
fi

echo "Published prefix/path: /$REPO dists: $DIST"
aptly publish show "$DIST" "$REPO" || true
REMOTE

echo "Published to echo-ci ($ECHO_CI_SSH_HOST)"
