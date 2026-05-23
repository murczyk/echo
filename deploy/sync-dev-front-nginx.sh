#!/usr/bin/env bash
set -euo pipefail

INCLUDE_PATH="${ECHO_DEV_FRONT_PROXY_INCLUDE:-/etc/nginx/echo-dev-front-proxy.inc}"
UPSTREAM_HOST="${ECHO_DEV_FRONT_PROXY_HOST:-127.0.0.1}"

find_elm_land_pids_desc() {
    ps -eo pid=,etimes=,cmd= \
        | awk '/node .*elm-land server/ { print $1, $2 }' \
        | sort -nk2,2
}

find_listen_port_for_pid() {
    local pid="$1"
    ss -ltnp \
        | awk -v pid="${pid}" '
            $0 ~ ("pid=" pid ",") {
                split($4, addr_parts, ":");
                print addr_parts[length(addr_parts)];
                exit 0;
            }
        '
}

elm_land_port=""

if [[ "${1:-}" != "" ]]; then
    elm_land_port="$1"
else
    elm_land_pids="$(find_elm_land_pids_desc)"
    if [[ -z "${elm_land_pids}" ]]; then
        echo "No running Elm Land server process found. Start it first with: just dev-front" >&2
        exit 1
    fi

    while IFS= read -r candidate_pid; do
        [[ -z "${candidate_pid}" ]] && continue
        candidate_pid="${candidate_pid%% *}"
        elm_land_port="$(find_listen_port_for_pid "${candidate_pid}")"
        if [[ -n "${elm_land_port}" ]]; then
            break
        fi
    done <<< "${elm_land_pids}"
fi

if [[ -z "${elm_land_port}" ]]; then
    echo "Found Elm Land process(es), but failed to detect any listening port." >&2
    exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
    echo "⚠️  Skipping nginx sync: this script is not running as root." >&2
    echo "🚧  wildducks.localhost may still proxy to an old Elm Land port." >&2
    echo "🔧  Run under sudo to update ${INCLUDE_PATH} -> ${UPSTREAM_HOST}:${elm_land_port}." >&2
    exit 0
fi

tmp_file="$(mktemp)"
trap 'rm -f "${tmp_file}"' EXIT

cat > "${tmp_file}" <<EOF
proxy_pass http://${UPSTREAM_HOST}:${elm_land_port};
proxy_http_version 1.1;
proxy_set_header Host \$host;
proxy_set_header Upgrade \$http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 600;
proxy_connect_timeout 600;
proxy_send_timeout 600;
EOF

if test -f "${INCLUDE_PATH}" && cmp -s "${tmp_file}" "${INCLUDE_PATH}"; then
    echo "Nginx dev-front include is already in sync: ${INCLUDE_PATH} -> ${UPSTREAM_HOST}:${elm_land_port}"
else
    cp "${tmp_file}" "${INCLUDE_PATH}"
    echo "Updated ${INCLUDE_PATH} -> ${UPSTREAM_HOST}:${elm_land_port}"
fi

nginx -t
systemctl restart nginx
echo "Restarted nginx. Frontend facade should now proxy to Elm Land on ${UPSTREAM_HOST}:${elm_land_port}"
