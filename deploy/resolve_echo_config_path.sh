#!/usr/bin/env bash

resolve_echo_config_path() {
    local mode="$1"

    if [[ -n "${ECHO_CONFIG_PATH:-}" ]]; then
        printf '%s\n' "$ECHO_CONFIG_PATH"
        return 0
    fi

    case "$mode" in
        live)
            printf '%s\n' "deploy/config.toml"
            ;;
        test)
            printf '%s\n' "deploy/config-test.toml"
            ;;
        debug)
            if [[ -f "deploy/config.toml" ]]; then
                printf '%s\n' "deploy/config.toml"
            else
                printf '%s\n' "deploy/config-debug.toml"
            fi
            ;;
        *)
            echo "Unsupported mode: $mode" >&2
            return 2
            ;;
    esac
}
