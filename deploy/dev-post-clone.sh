#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  dev-post-clone.sh --ts-key <TS_KEY> --machine <MACHINE> --domain <DOMAIN> --ssh-public-key <SSH_PUBLIC_KEY>

Required:
  --domain           Tailscale DNS name, e.g. ziggy-dev-echo.eagle-atria.ts.net
  --ssh-public-key   Public SSH key to add for the dev user

Optional:
  --ts-key           Tailscale auth key (kept for logging)
  --machine          Machine name (used for printing SSH config)
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
SSH_PUBLIC_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ts-key)
      TS_KEY="$2"
      shift 2
      ;;
    --machine)
      MACHINE="$2"
      shift 2
      ;;
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --ssh-public-key)
      SSH_PUBLIC_KEY="$2"
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

# normalize domain input
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
PUBLIC_HOST="${DOMAIN}"

find_dev_user() {
  local user
  user=$(getent passwd 1000 | cut -d: -f1 || true)
  if [[ -z "$user" ]]; then
    for cand in ubuntu echo; do
      if id -u "$cand" >/dev/null 2>&1; then
        user="$cand"
        break
      fi
    done
  fi
  echo "$user"
}

add_ssh_key() {
  local user="$1"
  local key="$2"
  local home

  [[ -n "$key" ]] || return 0
  if [[ -z "$user" ]]; then
    warn "Could not detect dev user (uid 1000). Skipping SSH key install."
    return 0
  fi

  home=$(getent passwd "$user" | cut -d: -f6)
  if [[ -z "$home" ]]; then
    warn "Could not find home for user '$user'. Skipping SSH key install."
    return 0
  fi

  run_root mkdir -p "$home/.ssh"
  run_root chmod 700 "$home/.ssh"
  run_root touch "$home/.ssh/authorized_keys"
  run_root chmod 600 "$home/.ssh/authorized_keys"

  if ! run_root grep -qxF "$key" "$home/.ssh/authorized_keys"; then
    printf '%s\n' "$key" | run_root tee -a "$home/.ssh/authorized_keys" >/dev/null
  fi

  run_root chown -R "$user":"$user" "$home/.ssh"
  log "SSH key installed for user '$user'"
}

update_toml_public_host() {
  local file="$1"
  local value="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  if grep -qE '^\s*public_host\s*=' "$file"; then
    run_root sed -i -E "s|^\s*public_host\s*=.*|public_host = \"${value}\"|" "$file"
  else
    printf '\npublic_host = "%s"\n' "$value" | run_root tee -a "$file" >/dev/null
  fi
  log "Updated public_host in $file"
}

update_public_host_configs() {
  shopt -s nullglob
  local files=(
    /etc/echo/config.toml
    /home/*/workspace/echo/deploy/config.toml
    /root/workspace/echo/deploy/config.toml
    /workspace/echo/deploy/config.toml
  )
  shopt -u nullglob

  local found=0
  for file in "${files[@]}"; do
    if [[ -f "$file" ]]; then
      update_toml_public_host "$file" "$PUBLIC_HOST"
      found=1
    fi
  done

  if [[ "$found" -eq 0 ]]; then
    warn "No config.toml files found to update public_host"
  fi
}

update_nginx() {
  local nginx_dir="/etc/nginx/sites-enabled"
  local nginx_file="$nginx_dir/echo"

  if [[ ! -f "$nginx_file" && -d "$nginx_dir" ]]; then
    local candidate
    candidate=$(grep -rl "echo-dev-template" "$nginx_dir" 2>/dev/null | head -n1 || true)
    if [[ -z "$candidate" ]]; then
      candidate=$(grep -rl "server_name[[:space:]]\\+echo\\.local" "$nginx_dir" 2>/dev/null | head -n1 || true)
    fi
    if [[ -n "$candidate" ]]; then
      nginx_file="$candidate"
    fi
  fi

  if [[ -f "$nginx_file" ]]; then
    if [[ "$(basename "$nginx_file")" == "echo" ]]; then
      local renamed="$nginx_dir/$DOMAIN"
      if [[ ! -e "$renamed" ]]; then
        run_root mv "$nginx_file" "$renamed"
        nginx_file="$renamed"
      fi
    fi

    run_root sed -i -E "s|^\s*server_name\s+[^;]+;|    server_name ${DOMAIN};|" "$nginx_file"
    log "Updated nginx server_name in $nginx_file"

    if command -v nginx >/dev/null 2>&1; then
      if run_root nginx -t; then
        run_root nginx -s reload || true
      fi
    fi
  else
    warn "nginx config not found under $nginx_dir"
  fi
}

update_coolwsd() {
  local file="/etc/coolwsd/coolwsd.xml"
  if [[ -f "$file" ]]; then
    run_root sed -i "s/oblik-os-dev-template\\.tawny-prometheus\\.ts\\.net/${DOMAIN}/g" "$file"
    run_root sed -i "s/echo-dev-template\\.eagle-atria\\.ts\\.net/${DOMAIN}/g" "$file"
    log "Updated $file"

    if command -v systemctl >/dev/null 2>&1; then
      run_root systemctl restart coolwsd >/dev/null 2>&1 || true
    fi
  else
    warn "coolwsd config not found at $file"
  fi
}

renew_cert() {
  if command -v echo-install-utils >/dev/null 2>&1; then
    run_root echo-install-utils renew-cert --cert-name https --reload --app-name echo --domain "$DOMAIN" --force --interactive=false
    log "Renewed cert for $DOMAIN"
  else
    warn "echo-install-utils not found; skipping cert renewal"
  fi
}

main() {
  log "Starting post-clone setup"
  local dev_user
  dev_user="$(find_dev_user)"
  if [[ -n "$SSH_PUBLIC_KEY" ]]; then
    add_ssh_key "$dev_user" "$SSH_PUBLIC_KEY"
  else
    warn "No --ssh-public-key provided; skipping SSH key install"
  fi

  update_public_host_configs
  update_nginx
  update_coolwsd
  renew_cert

  echo
  echo "✅ Ready: https://${DOMAIN}"
  if [[ -n "$MACHINE" ]]; then
    echo
    echo "SSH config:"
    cat <<CFG
Host ${MACHINE}
    HostName ${DOMAIN}
CFG
    if [[ -n "$dev_user" ]]; then
      echo "    User ${dev_user}"
    fi
  fi

  if [[ -n "$TS_KEY" ]]; then
    echo "(TS_KEY was provided for ${MACHINE:-this machine})"
  fi
}

main
