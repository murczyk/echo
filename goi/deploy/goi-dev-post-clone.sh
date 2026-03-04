#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  goi-dev-post-clone.sh --domain <DOMAIN> [--machine <MACHINE>] [--ts-key <TS_KEY>]

Required:
  --domain           Tailscale DNS name, e.g. ziggy-dev-goi.eagle-atria.ts.net

Optional:
  --machine          Machine name (used for printing SSH config)
  --ts-key           Tailscale auth key (kept for logging)
  -h, --help         Show this help
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARN: $*" >&2
}

log() {
  echo "INFO: $*"
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

TS_KEY=""
MACHINE=""
DOMAIN=""
GOI_APP_DIR="${GOI_APP_DIR:-/etc/goi}"
SCRIPT_BUNDLE_DIR="${SCRIPT_BUNDLE_DIR:-/var/tmp/goi-dev-container}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ts-key)
      TS_KEY="${2:-}"
      shift 2
      ;;
    --machine)
      MACHINE="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$DOMAIN" ]] || die "Missing --domain"

DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"

find_app_user() {
  if id -u echo >/dev/null 2>&1; then
    echo "echo"
    return
  fi
  if id -u ubuntu >/dev/null 2>&1; then
    echo "ubuntu"
    return
  fi
  echo ""
}

ensure_goi_dir() {
  local app_user="$1"
  run_root mkdir -p "$GOI_APP_DIR"
  if [[ -n "$app_user" ]] && id -u "$app_user" >/dev/null 2>&1; then
    run_root chown -R "$app_user":"$app_user" "$GOI_APP_DIR"
  fi
}

install_required_file() {
  local src="$1"
  local dst="$2"
  local mode="$3"
  local owner="$4"

  if [[ ! -f "$src" ]]; then
    die "Missing required bundle file: $src (expected under ${SCRIPT_BUNDLE_DIR})"
  fi

  run_root install -D -m "$mode" "$src" "$dst"
  run_root chown "$owner" "$dst"
  log "Installed $dst"
}

install_service_bundle() {
  local app_user="$1"
  local app_owner="root:root"
  if [[ -n "$app_user" ]] && id -u "$app_user" >/dev/null 2>&1; then
    app_owner="${app_user}:${app_user}"
  fi

  ensure_goi_dir "$app_user"

  install_required_file "${SCRIPT_BUNDLE_DIR}/goi.service" "/etc/systemd/system/goi.service" "0644" "root:root"
  install_required_file "${SCRIPT_BUNDLE_DIR}/goi-npm-start.sh" "${GOI_APP_DIR}/goi-npm-start.sh" "0755" "$app_owner"
  install_required_file "${SCRIPT_BUNDLE_DIR}/goi-renew-tailscale-cert.sh" "/usr/local/sbin/goi-renew-tailscale-cert.sh" "0755" "root:root"
  install_required_file "${SCRIPT_BUNDLE_DIR}/goi-renew-tailscale-cert.service" "/etc/systemd/system/goi-renew-tailscale-cert.service" "0644" "root:root"
  install_required_file "${SCRIPT_BUNDLE_DIR}/goi-renew-tailscale-cert.timer" "/etc/systemd/system/goi-renew-tailscale-cert.timer" "0644" "root:root"

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping unit setup"
    return 0
  fi

  run_root systemctl daemon-reload
  run_root systemctl enable --now goi-renew-tailscale-cert.timer >/dev/null 2>&1 || true
  run_root systemctl start goi-renew-tailscale-cert.service >/dev/null 2>&1 || true
  run_root systemctl enable goi.service >/dev/null 2>&1 || true

  if [[ -f "${GOI_APP_DIR}/package.json" ]]; then
    run_root systemctl restart goi.service >/dev/null 2>&1 || warn "Failed to restart goi.service"
  else
    warn "Skipping goi.service restart: ${GOI_APP_DIR}/package.json not found"
  fi
}

update_nginx() {
  local nginx_dir="/etc/nginx/sites-enabled"
  local canonical_nginx_file="${nginx_dir}/goi"
  local nginx_file="$canonical_nginx_file"

  if [[ ! -d "$nginx_dir" ]]; then
    warn "nginx config directory not found: $nginx_dir"
    return 0
  fi

  if [[ ! -f "$nginx_file" ]]; then
    local candidate

    if [[ -f "${nginx_dir}/${DOMAIN}" ]]; then
      candidate="${nginx_dir}/${DOMAIN}"
    else
      candidate="$(grep -rl "proxy_pass[[:space:]]\\+http://localhost:4000" "$nginx_dir" 2>/dev/null | head -n1 || true)"
    fi

    if [[ -n "$candidate" ]]; then
      if [[ "$candidate" != "$canonical_nginx_file" ]]; then
        run_root mv "$candidate" "$canonical_nginx_file"
        log "Normalized nginx site filename to $canonical_nginx_file (from $(basename "$candidate"))"
      fi
      nginx_file="$canonical_nginx_file"
    fi
  fi

  if [[ ! -f "$nginx_file" ]]; then
    warn "nginx site config not found under $nginx_dir"
    return 0
  fi

  if grep -qE '^\s*server_name\s+[^;]+;' "$nginx_file"; then
    run_root sed -i -E "s|^\s*server_name\s+[^;]+;|    server_name ${DOMAIN};|" "$nginx_file"
  else
    warn "No server_name directive found in $nginx_file; skipping server_name update"
    return 0
  fi

  log "Updated nginx server_name in $nginx_file"

  if command -v nginx >/dev/null 2>&1; then
    if run_root nginx -t; then
      if command -v systemctl >/dev/null 2>&1 && run_root systemctl list-unit-files nginx.service >/dev/null 2>&1; then
        run_root systemctl reload nginx >/dev/null 2>&1 || run_root systemctl restart nginx >/dev/null 2>&1 || true
      else
        run_root nginx -s reload || true
      fi
    fi
  fi
}

renew_cert() {
  if ! command -v echo-install-utils >/dev/null 2>&1; then
    warn "echo-install-utils not found; skipping cert renewal"
    return 0
  fi

  run_root echo-install-utils renew-cert \
    --interactive=false \
    --app-name goi \
    --cert-name tailscale \
    --domain "$DOMAIN" \
    --reload nginx.service \
    --force

  log "Renewed GOI tailscale certificate for ${DOMAIN}"
}

print_ready_banner() {
  local app_user="$1"
  echo
  echo "Ready: https://${DOMAIN}"

  if [[ -n "$MACHINE" ]]; then
    echo
    echo "SSH config:"
    cat <<CFG
Host ${MACHINE}
    HostName ${DOMAIN}
CFG
    if [[ -n "$app_user" ]]; then
      echo "    User ${app_user}"
    fi
  fi

  if [[ -n "$TS_KEY" ]]; then
    echo "(TS_KEY was provided for ${MACHINE:-this machine})"
  fi
}

main() {
  log "Starting GOI post-clone setup"

  local app_user
  app_user="$(find_app_user)"
  if [[ -z "$app_user" ]]; then
    warn "Neither 'echo' nor 'ubuntu' user exists; GOI app files will be owned by root"
  fi

  install_service_bundle "$app_user"
  update_nginx
  renew_cert
  print_ready_banner "$app_user"
}

main
