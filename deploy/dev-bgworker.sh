#!/usr/bin/env bash
set -euo pipefail

quiet="false"
log_sql="false"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
    cat >&2 <<'EOF'
Usage:
  dev-bgworker [--quiet[=true|false]] [--log-sql[=true|false]] [--] [extra worker args...]
EOF
}

parse_bool() {
    case "$1" in
        true|false)
            printf '%s\n' "$1"
            ;;
        *)
            echo "Invalid boolean value: $1. Expected true or false." >&2
            exit 2
            ;;
    esac
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --quiet)
            quiet="true"
            shift
            ;;
        --quiet=*)
            quiet="$(parse_bool "${1#*=}")"
            shift
            ;;
        --log-sql)
            log_sql="true"
            shift
            ;;
        --log-sql=*)
            log_sql="$(parse_bool "${1#*=}")"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        --*)
            echo "Unknown dev-bgworker option: $1" >&2
            usage
            exit 2
            ;;
        *)
            break
            ;;
    esac
done

stop_existing_bgworker() {
    local pids

    pids="$(
        ps -eo pid=,command= |
            awk '
                /cargo watch -- cargo run -- --mode=debug bgworker/ ||
                /wdintel-rs --mode=debug bgworker/ {
                    print $1
                }
            '
    )"
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null || true
    fi
}

filter_quiet_output() {
    awk '
        function is_build_error(line, lower) {
            lower = tolower(line)
            return lower ~ /^error(\[[^]]+\])?:/ ||
                lower ~ /^error: /
        }

        function is_build_continuation(line) {
            return line ~ /^[[:space:]]/ ||
                line ~ /^= note:/ ||
                line ~ /^= help:/ ||
                line ~ /^note:/ ||
                line ~ /^help:/
        }

        function is_panic(line) {
            return line ~ /^thread .* panicked at / ||
                line ~ /^panic:/
        }

        function emit(line) {
            print line
            fflush()
        }

        {
            if (is_build_error($0)) {
                emit($0)
                keep_continuation = 1
                next
            }

            if (is_panic($0)) {
                emit($0)
                keep_continuation = 1
                next
            }

            if (keep_continuation && is_build_continuation($0)) {
                emit($0)
                next
            }

            keep_continuation = 0
        }
    '
}

run_bgworker() {
    RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug bgworker "$@"
}

stop_existing_bgworker

cd "$repo_root/wdintel-rs"

if [ "$log_sql" = "true" ]; then
    export RUST_LOG=sqlx=trace,seaorm=trace
fi

if [ "$quiet" = "true" ]; then
    export RUST_LOG=${RUST_LOG:-error}
    echo "backend bgworker is running in quiet mode; only build errors and panics will be shown" >&2
    run_bgworker "$@" 2>&1 | filter_quiet_output
else
    run_bgworker "$@"
fi
