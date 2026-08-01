#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
elm_land_default_port=1234

stop_default_port_listener() {
    local -a pids=()

    mapfile -t pids < <(lsof -tiTCP:"${elm_land_default_port}" -sTCP:LISTEN 2>/dev/null || true)
    if (( ${#pids[@]} == 0 )); then
        return
    fi

    echo "Stopping process(es) listening on port ${elm_land_default_port}: ${pids[*]}"
    kill "${pids[@]}" 2>/dev/null || true

    for _ in $(seq 1 50); do
        pids=()
        mapfile -t pids < <(lsof -tiTCP:"${elm_land_default_port}" -sTCP:LISTEN 2>/dev/null || true)
        if (( ${#pids[@]} == 0 )); then
            return
        fi
        sleep 0.1
    done

    echo "Force-stopping process(es) still listening on port ${elm_land_default_port}: ${pids[*]}"
    kill -KILL "${pids[@]}" 2>/dev/null || true
}

log_file="$(mktemp)"
log_pipe="$(mktemp -u)"

mkfifo "${log_pipe}"
tee "${log_file}" < "${log_pipe}" &
tee_pid=$!

cleanup() {
    rm -f "${log_file}"
    rm -f "${log_pipe}"
    kill "${server_pid}" 2>/dev/null || true
    kill "${tee_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
    wait "${tee_pid}" 2>/dev/null || true
}

extract_port_from_log() {
    sed -n 's/.*http:\/\/localhost:\([0-9][0-9]*\).*/\1/p' "${log_file}" | tail -n 1
}

cd "${repo_root}/wdintel-web"

stop_default_port_listener
npx elm-land server >"${log_pipe}" 2>&1 &
server_pid=$!

trap cleanup EXIT INT TERM

elm_land_port=""
for _ in $(seq 1 60); do
    elm_land_port="$(extract_port_from_log)"
    if [[ -n "${elm_land_port}" ]]; then
        break
    fi
    if ! kill -0 "${server_pid}" 2>/dev/null; then
        break
    fi
    sleep 1
done

if [[ -z "${elm_land_port}" ]]; then
    cat "${log_file}" >&2
    echo "Failed to detect Elm Land port." >&2
    exit 1
fi

if ! bash "${repo_root}/deploy/sync-dev-front-nginx.sh" "${elm_land_port}"; then
    echo "Skipping nginx sync; Elm Land is still running on port ${elm_land_port}." >&2
fi

wait "${server_pid}"
