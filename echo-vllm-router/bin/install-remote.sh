#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DEPLOY_ROOT=${1:?deployment staging directory is required}
ARTIFACT_DIR="$DEPLOY_ROOT/artifacts"
WHEELHOUSE_DIR="$ARTIFACT_DIR/wheelhouse"
INSTALL_ROOT=/opt/echo-vllm-router
CONFIG_ROOT=/etc/echo-vllm-router

[[ $EUID -eq 0 ]] || {
  printf '[echo-vllm-router] ERROR: install-remote.sh must run as root\n' >&2
  exit 1
}
[[ "$DEPLOY_ROOT" =~ ^/tmp/echo-vllm-router-deploy\.[A-Za-z0-9]+$ ]] || {
  printf '[echo-vllm-router] ERROR: unsafe staging directory: %s\n' "$DEPLOY_ROOT" >&2
  exit 1
}

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
load_bundle

declare -A router_changed=()
otel_changed=0
units_changed=0

verify_archive_members() {
  local archive=$1
  local member

  while IFS= read -r member; do
    [[ "$member" != /* ]] || die "absolute path in collector archive: $member"
    [[ "/$member/" != *'/../'* ]] || die "parent traversal in collector archive: $member"
  done < <(tar -tzf "$archive")
}

verify_stage() {
  local archive="$ARTIFACT_DIR/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"
  local binary_member="signoz-otel-collector_linux_amd64/bin/signoz-otel-collector"
  local binary_sha256
  local requirements_sha256

  [[ -d "$WHEELHOUSE_DIR" ]] || die "missing wheelhouse"
  [[ -f "$archive" ]] || die "missing collector archive"
  requirements_sha256=$(sha256sum "$BUNDLE_DIR/requirements.lock" | awk '{print $1}')
  [[ "$requirements_sha256" == "$VLLM_ROUTER_REQUIREMENTS_SHA256" ]] \
    || die "requirements.lock checksum mismatch"
  printf '%s  %s\n' "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256" "$archive" \
    | sha256sum --check --status - \
    || die "collector archive checksum mismatch"
  printf '%s  %s\n' "$VLLM_ROUTER_WHEEL_SHA256" "$WHEELHOUSE_DIR/$VLLM_ROUTER_WHEEL" \
    | sha256sum --check --status - \
    || die "router wheel checksum mismatch"
  verify_archive_members "$archive"
  binary_sha256=$(tar -xOzf "$archive" "$binary_member" | sha256sum | awk '{print $1}')
  [[ "$binary_sha256" == "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256" ]] \
    || die "collector binary checksum mismatch"
}

extract_collector() {
  local archive="$ARTIFACT_DIR/$SIGNOZ_OTEL_COLLECTOR_ARCHIVE"
  local binary_member="signoz-otel-collector_linux_amd64/bin/signoz-otel-collector"
  local binary="$DEPLOY_ROOT/signoz-otel-collector"

  tar -xOzf "$archive" "$binary_member" >"$binary"
  chmod 0755 "$binary"
  printf '%s\n' "$binary"
}

validate_collector_config() {
  local binary=$1
  local config="$DEPLOY_ROOT/otel-collector-validation.yaml"
  local copy_path="$DEPLOY_ROOT/collector-config-copy.yaml"
  local pool_key
  local status

  sed \
    "s|directory: /var/lib/echo-vllm-router-otel/file_storage|directory: $DEPLOY_ROOT/file_storage|" \
    "$BUNDLE_DIR/config/otel-collector.yaml" \
    >"$config"
  grep -Fx "    directory: $DEPLOY_ROOT/file_storage" "$config" >/dev/null

  set -a
  # shellcheck disable=SC1090
  source "$OTEL_ENV_FILE"
  for pool_key in "${POOL_KEYS[@]}"; do
    # shellcheck disable=SC1090
    source "$(pool_env_file "$pool_key")"
  done
  set +a
  set +e
  timeout 3 "$binary" \
    --config="$config" \
    --copy-path="$copy_path" \
    >"$DEPLOY_ROOT/collector-validation.log" 2>&1
  status=$?
  set -e
  [[ $status -eq 124 ]] || {
    sed -n '1,160p' "$DEPLOY_ROOT/collector-validation.log" >&2
    die "collector configuration validation failed"
  }
}

ensure_service_user() {
  local user=$1
  local passwd_entry

  if getent passwd "$user" >/dev/null; then
    passwd_entry=$(getent passwd "$user")
    (( $(cut -d: -f3 <<<"$passwd_entry") > 0 && $(cut -d: -f3 <<<"$passwd_entry") < 1000 )) \
      || die "$user is not a system user"
    [[ $(id -gn "$user") == "$user" ]] \
      || die "$user has an unexpected primary group"
    [[ $(cut -d: -f6 <<<"$passwd_entry") == /nonexistent ]] \
      || die "$user has an unexpected home directory"
    [[ $(cut -d: -f7 <<<"$passwd_entry") == /usr/sbin/nologin ]] \
      || die "$user has an unexpected login shell"
    return
  fi

  getent group "$user" >/dev/null || /usr/sbin/groupadd --system "$user"
  /usr/sbin/useradd \
    --system \
    --gid "$user" \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$user"
}

any_router_active() {
  local pool_key

  for pool_key in "${POOL_KEYS[@]}"; do
    if systemctl is-active --quiet "$(pool_unit "$pool_key")"; then return 0; fi
  done
  return 1
}

create_release() {
  local release_dir=$1
  local router_shebang

  if [[ -d "$release_dir" ]]; then
    router_shebang=$(head -n 1 "$release_dir/bin/vllm-router")
    if [[ $("$release_dir/bin/python" -c 'import vllm_router; print(vllm_router.__version__)') == "$VLLM_ROUTER_VERSION" ]] \
      && "$release_dir/bin/python" -m pip check >/dev/null \
      && [[ "$router_shebang" == "#!$release_dir/bin/python" || "$router_shebang" == "#!$release_dir/bin/python3" ]] \
      && "$release_dir/bin/vllm-router" --help >/dev/null; then
      return
    fi
    any_router_active \
      && die "refusing to replace an invalid release while a router pool is active"
    [[ "$release_dir" == /opt/echo-vllm-router/releases/* ]] \
      || die "unsafe release directory: $release_dir"
    rm -rf -- "$release_dir"
  fi

  trap '[[ -n "${release_dir:-}" && "$release_dir" == /opt/echo-vllm-router/releases/* ]] && rm -rf -- "$release_dir"' RETURN
  python3 -m venv "$release_dir"
  "$release_dir/bin/python" -m pip install \
    --disable-pip-version-check \
    --quiet \
    --no-index \
    --find-links="$WHEELHOUSE_DIR" \
    --require-hashes \
    --requirement "$BUNDLE_DIR/requirements.lock"
  "$release_dir/bin/python" -m pip check
  [[ $("$release_dir/bin/python" -c 'import vllm_router; print(vllm_router.__version__)') == "$VLLM_ROUTER_VERSION" ]] \
    || die "installed router version mismatch"
  "$release_dir/bin/vllm-router" --help >/dev/null
  trap - RETURN
}

activate_release() {
  local release_id=$1
  local current_target
  local next_link="$INSTALL_ROOT/.current.$$"

  if [[ -e "$INSTALL_ROOT/current" && ! -L "$INSTALL_ROOT/current" ]]; then
    die "$INSTALL_ROOT/current exists and is not a symbolic link"
  fi
  current_target=$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)
  if [[ "$current_target" == "releases/$release_id" ]]; then
    return 1
  fi

  ln -s "releases/$release_id" "$next_link"
  mv -Tf "$next_link" "$INSTALL_ROOT/current"
  return 0
}

install_if_changed() {
  local source=$1
  local destination=$2
  local mode=$3

  if [[ -f "$destination" ]] && cmp -s "$source" "$destination"; then
    return 1
  fi
  install -m "$mode" "$source" "$destination"
  return 0
}

install_collector_if_changed() {
  local source=$1
  local destination="$INSTALL_ROOT/bin/signoz-otel-collector"
  local installed_sha256=

  if [[ -f "$destination" ]]; then
    installed_sha256=$(sha256sum "$destination" | awk '{print $1}')
  fi
  if [[ "$installed_sha256" == "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256" ]]; then
    return 1
  fi
  install -m 0755 "$source" "$destination"
  return 0
}

mark_all_routers_changed() {
  local pool_key

  for pool_key in "${POOL_KEYS[@]}"; do router_changed[$pool_key]=1; done
}

install_pool_configs() {
  local pool_key
  local source
  local destination

  for pool_key in "${POOL_KEYS[@]}"; do
    source=$(pool_env_file "$pool_key")
    destination="$CONFIG_ROOT/$(basename "$source")"
    if install_if_changed "$source" "$destination" 0644; then
      router_changed[$pool_key]=1
      otel_changed=1
    fi
  done
}

install_files() {
  local collector_binary=$1
  local pool_key
  local release_id="$VLLM_ROUTER_VERSION-${VLLM_ROUTER_REQUIREMENTS_SHA256:0:12}"
  local release_dir="$INSTALL_ROOT/releases/$release_id"

  for pool_key in "${POOL_KEYS[@]}"; do router_changed[$pool_key]=0; done
  otel_changed=0
  units_changed=0

  install -d -m 0755 \
    "$INSTALL_ROOT/bin" \
    "$INSTALL_ROOT/manifest" \
    "$INSTALL_ROOT/releases" \
    "$CONFIG_ROOT"
  create_release "$release_dir"
  if activate_release "$release_id"; then mark_all_routers_changed; fi
  if install_collector_if_changed "$collector_binary"; then otel_changed=1; fi
  if install_if_changed "$BUNDLE_DIR/bin/run-router.sh" "$INSTALL_ROOT/bin/run-router" 0755; then
    mark_all_routers_changed
  fi

  install -m 0644 "$BUNDLE_DIR/versions.env" "$INSTALL_ROOT/manifest/versions.env"
  install -m 0644 "$BUNDLE_DIR/requirements.lock" "$INSTALL_ROOT/manifest/requirements.lock"
  install_pool_configs
  if install_if_changed "$BUNDLE_DIR/config/otel.env" "$CONFIG_ROOT/otel.env" 0644; then
    otel_changed=1
  fi
  if install_if_changed "$BUNDLE_DIR/config/otel-collector.yaml" "$CONFIG_ROOT/otel-collector.yaml" 0644; then
    otel_changed=1
  fi

  systemd-analyze verify \
    "$BUNDLE_DIR/systemd/echo-vllm-router.service" \
    "$BUNDLE_DIR/systemd/echo-vllm-router@.service" \
    "$BUNDLE_DIR/systemd/echo-vllm-router-otel.service"
  if install_if_changed "$BUNDLE_DIR/systemd/echo-vllm-router.service" /etc/systemd/system/echo-vllm-router.service 0644; then
    router_changed[general]=1
    units_changed=1
  fi
  if install_if_changed "$BUNDLE_DIR/systemd/echo-vllm-router@.service" /etc/systemd/system/echo-vllm-router@.service 0644; then
    router_changed[ocr-gemma]=1
    router_changed[nuextract]=1
    units_changed=1
  fi
  if install_if_changed "$BUNDLE_DIR/systemd/echo-vllm-router-otel.service" /etc/systemd/system/echo-vllm-router-otel.service 0644; then
    otel_changed=1
    units_changed=1
  fi
}

start_service() {
  local unit=$1
  local changed=$2

  if systemctl is-active --quiet "$unit"; then
    if [[ $changed -eq 1 ]]; then systemctl restart "$unit"; fi
  else
    systemctl start "$unit"
  fi
}

start_services() {
  local pool_key
  local unit

  if [[ $units_changed -eq 1 ]]; then systemctl daemon-reload; fi
  for pool_key in "${POOL_KEYS[@]}"; do
    unit=$(pool_unit "$pool_key")
    systemctl enable "$unit" >/dev/null
    start_service "$unit" "${router_changed[$pool_key]}"
  done
  systemctl enable echo-vllm-router-otel.service >/dev/null
  start_service echo-vllm-router-otel.service "$otel_changed"
}

exec 9>/run/lock/echo-vllm-router-deploy.lock
flock -n 9 || die "another deployment is running"

verify_stage
collector_binary=$(extract_collector)
validate_collector_config "$collector_binary"
ensure_service_user echo-vllm-router
ensure_service_user echo-vllm-router-otel
install_files "$collector_binary"
start_services

log "Deployment completed"
