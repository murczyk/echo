set positional-arguments := true

dt1 := `date -u +%Y-%m-%d-%H-%M-%S`
pgdb := "wd"
pgpwd := "fee_-_-_-FnoeKFBeebu87bf"
log_sql := "false"
rust_log := if log_sql == "true" { "RUST_LOG=sqlx=trace,seaorm=trace " } else { "" }
no_bgworker := "false"
dev_back_args := if no_bgworker == "true" { "--no-bgworker" } else { "" }
server := ""
target := ""
backup_key_id := `if [ -f "./deploy/config-backup.toml" ]; then tomlq backup_key_id -f ./deploy/config-backup.toml; else echo ""; fi`
backup_key := `if [ -f "./deploy/config-backup.toml" ]; then tomlq backup_key -f ./deploy/config-backup.toml; else echo ""; fi`
builder := ""
quote := "'"
branch := "main"
vault_addr := "https://127.0.0.1:8200"
vault_cert_path := "/tmp/vault-tls331936176/vault-ca.pem"
vault_server := "localhost"
is_dev := "true"
app := "echo"
interactive_setup := "true"
origin := ""
echo_bin := "wdintel-rs"
discord_webhook_infra := "https://discord.com/api/webhooks/1417084833384890398/7jgZyC1zpmrJVXzUwDz-OQV6_UwqxUUl9GHehVyV9-UwxQRZjMg9ZwYYNJGPcAmuiGRA"
since_ts := "1645664400000"
till_ts := "1961204400000"
datasource_id := "1"
message := ""
unit := ""
b2_endpoint_url := "https://s3.eu-central-003.backblazeb2.com"
storage_dir := home_directory() + "/Downloads/storage"
ai_bucket_prefix := "s3://echouastorage/lfs/echo-ai/models-v2"
wd_fasttext_models := justfile_directory() + "/echo-ai/fasttext-models"
workspace_iggy := "~/workspace/iggy"
local_assets_iggy := "echo-iggy/deploy"
iggy_fork_remote := "https://github.com/k-bx/iggy.git"
iggy_default_rev := "k-bx/2026-06-18-poll-option"

default:
    @just --list

prepare-workspace:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{ justfile_directory() }}"

    limit_kib=$((75 * 1024 * 1024))
    used_kib=$(du -sk . | awk '{print $1}')
    used_gib=$(awk -v kib="$used_kib" 'BEGIN { printf "%.1f", kib / 1024 / 1024 }')

    if (( used_kib > limit_kib )); then
        echo "Project uses ${used_gib} GiB, above 75 GiB; running cargo clean."
        cargo clean
    else
        echo "Project uses ${used_gib} GiB, below 75 GiB; skipping cargo clean."
    fi

# setup pgBackRest: runs on `--server`; `--backup-name` selects which host's backup/stanza config will be installed (defaults to `--server`)
[arg('backup_name', long='backup-name')]
[arg('daily_restore', long='daily-restore', value='true')]
[arg('server', long='server')]
setup-pgbackrest server backup_name="" daily_restore="false":
    #!/bin/bash
    set -euxo pipefail
    args=(--server "{{ server }}")
    if [[ "{{ backup_name }}" != "" ]]; then
        args+=(--backup-name "{{ backup_name }}")
    fi
    if [[ "{{ daily_restore }}" == "true" ]]; then
        args+=(--daily-restore)
    fi
    bash deploy/setup-pgbackrest.sh "${args[@]}"

_print-servers:
    @echo "❌ Server parameter not recognized. Value: {{ server }}"

evaluate:
    @just --evaluate

dev-front:
    bash deploy/dev-front.sh

# now with build!
dev-front2:
    (cd wdintel-web && npm ci && npx elm-land build && npx elm-land server)

build-front:
    #!/bin/bash
    set -euxo pipefail
    cd wdintel-web

    # Install/update deps before build so elm-land uses project-pinned toolchain.
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.npm_installed" ] || [ "package-lock.json" -nt "node_modules/.npm_installed" ]; then
        npm ci
        touch node_modules/.npm_installed
    fi

    npm run build

[arg('log_sql', long='log-sql', value='true')]
[arg('quiet', long='quiet', value='true')]
dev-back quiet="false" log_sql="false" *args: prepare-workspace
    bash deploy/dev-back.sh --quiet="{{ quiet }}" --log-sql="{{ log_sql }}" -- {{ dev_back_args }} {{ args }}

[arg('log_sql', long='log-sql', value='true')]
[arg('quiet', long='quiet', value='true')]
dev-bgworker quiet="false" log_sql="false" *args:
    bash deploy/dev-bgworker.sh --quiet="{{ quiet }}" --log-sql="{{ log_sql }}" -- {{ args }}

dev-back-noproj:
    # Run backend without `proj` feature for local development
    (cd wdintel-rs && {{ rust_log }}cargo watch -- cargo run --no-default-features -- --mode=debug server {{ dev_back_args }})

dev-back-sudo:
    (cd wdintel-rs && cargo build && cd .. && {{ rust_log }}sudo ./target/debug/wdintel-rs --mode=debug server {{ dev_back_args }})

ssh-pivnich:
    bash deploy/ssh-pivnich.sh

ssh-skhid:
    bash deploy/ssh-skhid.sh

ssh-zp2:
    bash deploy/ssh-zp2.sh

ssh-staging:
    bash deploy/ssh-staging.sh

# mkdir -p ~/Downloads/storage

# see wdintel-py/README.md
dev-py:
    bash deploy/dev-py.sh "{{ storage_dir }}" "{{ wd_fasttext_models }}"

setup-dev:
    # todo: setup everything?
    npm install uglify-js -g

gen-seaorm:
    (cd wdintel-rs && sea-orm-cli generate entity --with-serde both -u postgres://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd -o src/entities)
    python3 deploy/patch_seaorm.py
    just fmt

gen-front: gen-elm gen-ts

gen-transcriber mode="debug":
    just migrate-all-up {{ mode }}
    just gen-seaorm
    just gen-front

gen-elm:
    (cd wdintel-rs && cargo run -- --mode=debug gen-elm)

gen-ts:
    (cd wdintel-rs && cargo run -- --mode=debug gen-ts)

test-fe:
    #!/bin/bash
    set -euxo pipefail
    cd wdintel-web

    # Check if node_modules exists and package-lock.json hasn't changed
    if [ ! -d "node_modules" ] || [ "package-lock.json" -nt "node_modules/.npm_installed" ]; then
        echo "Installing npm dependencies..."
        npm ci
        touch "node_modules/.npm_installed"
    else
        echo "npm dependencies already up to date, skipping installation"
    fi

    npm test

test-be:
    #!/bin/bash
    set -euxo pipefail
    cd wdintel-rs

    # Use incremental compilation for faster builds
    export CARGO_INCREMENTAL=1
    export RUSTC_WRAPPER=""

    echo "Running cargo clippy..."
    # Lint all targets; fail on any warning. Use --release in CI to reuse artifacts.
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
        cargo clippy --release --all-targets --all-features -- -D warnings
    else
        cargo clippy --all-targets --all-features -- -D warnings
    fi

    # Check if we should use cached build
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
        echo "Running Rust tests in CI with optimizations..."
        cargo test --release --locked
    else
        echo "Running Rust tests locally..."
        cargo test --release
    fi

test: test-fe test-be

test-transcriber:
    cargo test -p wdintel-rs transcri -- --nocapture
    cd wdintel-web && npm run test:ts -- src/ts/react/routes/admin-system-settings-neo src/ts/react/services/api

verify-transcriber:
    cargo fmt --all -- --check
    cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings
    cargo check -p wdintel-rs
    cargo test -p wdintel-rs
    cd wdintel-web && npm run test:ts
    just build-front

# CI commands
ci-setup-cache clean="false":
    bash deploy/setup_ci_cache.sh {{ clean }}

ci-save-cache clean="false":
    bash deploy/save_ci_cache.sh {{ clean }}

ci-setup-cache-frontend:
    bash deploy/setup_ci_cache_frontend.sh

ci-save-cache-frontend:
    bash deploy/save_ci_cache_frontend.sh

ci-setup-cache-optimized clean="false":
    bash deploy/setup_ci_cache_optimized.sh {{ clean }}

ci-save-cache-optimized clean="false":
    bash deploy/save_ci_cache_optimized.sh {{ clean }}

ci-setup-cache-sccache clean="false":
    bash deploy/setup_ci_cache_sccache.sh {{ clean }}

ci-save-cache-sccache clean="false":
    bash deploy/save_ci_cache_sccache.sh {{ clean }}

# Full CI test suite: backend CI flow plus frontend TypeScript tests.
ci-test:
    bash deploy/run_ci_tests.sh

# Backend-only CI test flow.
ci-test-backend:
    bash deploy/run_backend_tests.sh

# Backward-compatible alias. Prefer `ci-test-backend`.
ci-test-be:
    @just ci-test-backend

[arg('builder', long='builder')]
ci-clean builder="echo-build-main":
    #!/bin/bash
    set -euo pipefail
    BUILDER="{{ builder }}"
    if [[ -z "$BUILDER" ]]; then
      echo "missing --builder (example: just ci-clean --builder echo-build-main)" >&2
      exit 1
    fi

    echo "🧹 Cleaning CI caches on ${BUILDER}..."
    ssh "${BUILDER}" 'set -euo pipefail
      echo "host=$(hostname) user=$(whoami)"

      cache_root="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
      echo "Removing cache root: ${cache_root}"
      rm -rf -- "${cache_root}" || true

      # spaCy/pip caches (best-effort)
      rm -rf -- "$HOME/.cache/spacy" || true
      rm -rf -- "$HOME/.cache/pip" || true
      rm -rf -- "/tmp/cache" || true

      # Remove workspace-local caches. Keep `.git` so Actions can reuse checkout.
      for ws in \
        "$HOME/workspace/echo" \
        "$HOME/actions-runner"*/_work/echo/echo \
        /home/ubuntu/actions-runner*/_work/echo/echo; do
        [[ -d "$ws" ]] || continue
        echo "Cleaning workspace caches under: $ws"
        rm -rf -- "$ws/target" || true
        rm -rf -- "$ws/wdintel-rs/wdintel-py/.venv" || true
        rm -rf -- "$ws/wdintel-web/node_modules" || true
      done

      echo "✅ CI cache cleanup done"
    '

setup-test-db branch_name="":
    #!/bin/bash
    if [ -n "{{ branch_name }}" ]; then
        bash deploy/setup_test_database.sh "{{ branch_name }}"
    else
        bash deploy/setup_test_database.sh
    fi

cleanup-test-dbs:
    bash deploy/setup_test_database.sh --cleanup

clean-deps:
    bash deploy/clean_deps.sh

lint:
    ( cd wdintel-rs && cargo clippy)

# sudo apt install exuberant-ctags
tags:
    rm TAGS || true
    rusty-tags -s ./wdintel-rs emacs
    mv ./wdintel-rs/rusty-tags.emacs TAGS

# Set repo hooks path so everyone uses shared hooks
setup-git-hooks:
    #!/bin/bash
    set -euo pipefail
    mkdir -p .githooks
    chmod +x .githooks/* 2>/dev/null || true
    git config core.hooksPath .githooks
    echo "core.hooksPath set to .githooks"

check-git-hooks:
    #!/bin/bash
    set -euo pipefail
    hooks_path=$(git config core.hooksPath || true)
    echo "core.hooksPath=${hooks_path:-<unset>}"
    if [ "${hooks_path:-}" != ".githooks" ]; then
      echo "Run: just setup-git-hooks" && exit 1
    fi
    echo "Shared git hooks are enabled."
    # rm ./wdintel-rs/rusty-tags.emacs || true
    cat echo-install/rusty-tags.emacs >> TAGS
    rm echo-install/rusty-tags.emacs || true
    find ./wdintel-web/src -type f -name '*.elm' -print0 | xargs -0 etags --regex @elm.tags  --append

# One-off migration for Signal bots that still use native signal-cli.

# Safe to rerun: it only targets clients whose DB config is still set to native.
[arg('non_interactive', long='non-interactive', value='true')]
[arg('server', long='server')]
[arg('yolo', long='yolo', value='true')]
migrate-signal-bots-to-jvm server non_interactive="false" yolo="false":
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers
        exit 1
    fi
    if [[ "{{ yolo }}" != "true" && ! -f "deploy/nginx/{{ server }}" ]]; then
        echo "Server parameter not recognized. Value: {{ server }}"
        echo "Available servers:"
        find deploy/nginx -maxdepth 1 -type f -printf '%f\n' | sort
        exit 1
    fi

    if [[ "{{ non_interactive }}" != "true" ]]; then
        echo ""
        echo "This operation may install Java, install signal-cli, update Signal bot env files,"
        echo "restart echo-signal-bot services, and modify {{ pgdb }}.echo_client_config on {{ server }}."
        echo

        read -r -p "Continue? [y/N] " reply
        [[ "$reply" =~ ^[Yy]$ ]] || exit 1
    fi

    set -x
    ssh {{ server }} 'bash -se' <<'EOF'
    set -euo pipefail

    PG_DB="{{ pgdb }}"
    MIN_JAVA_MAJOR="${MIN_JAVA_MAJOR:-25}"
    SIGNAL_ROOT="/etc/echo/signal-cli-data"
    TMP_DIR=$(mktemp -d /tmp/echo-signal-jvm-migration.XXXXXX)
    trap 'rm -rf "$TMP_DIR"' EXIT

    require_cmd() {
        if ! command -v "$1" >/dev/null 2>&1; then
            echo "Missing required command: $1" >&2
            exit 1
        fi
    }

    java_major_version() {
        if ! command -v java >/dev/null 2>&1; then
            return 1
        fi

        java -version 2>&1 | awk -F '[".]' '/version/ { if ($2 == 1) print $3; else print $2; exit }'
    }

    ensure_compatible_java() {
        local current_java_major=""
        current_java_major=$(java_major_version || true)

        if [[ -n "$current_java_major" && "$current_java_major" -ge "$MIN_JAVA_MAJOR" ]]; then
            return 0
        fi

        if [[ -z "$current_java_major" ]]; then
            echo "Java is not installed on the server. signal-cli requires Java ${MIN_JAVA_MAJOR} or newer."
        else
            echo "Java ${current_java_major} is installed, but signal-cli requires Java ${MIN_JAVA_MAJOR} or newer."
        fi

        echo "Installing/upgrading Java to a compatible version..."

        require_cmd apt-get
        sudo env DEBIAN_FRONTEND=noninteractive apt-get update

        java_packages=(
            "openjdk-${MIN_JAVA_MAJOR}-jre-headless"
            "openjdk-${MIN_JAVA_MAJOR}-jre"
            "openjdk-${MIN_JAVA_MAJOR}-jdk-headless"
            "openjdk-${MIN_JAVA_MAJOR}-jdk"
        )
        java_installed=0
        for java_package in "${java_packages[@]}"; do
            if sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "$java_package"; then
                java_installed=1
                break
            fi
        done

        if [[ "$java_installed" != "1" ]]; then
            echo "Failed to install a compatible Java runtime for signal-cli." >&2
            exit 1
        fi

        current_java_major=$(java_major_version || true)
        if [[ -z "$current_java_major" || "$current_java_major" -lt "$MIN_JAVA_MAJOR" ]]; then
            echo "Java upgrade did not produce a compatible runtime; expected >= ${MIN_JAVA_MAJOR}, got ${current_java_major:-missing}." >&2
            exit 1
        fi
    }

    ensure_signal_cli() {
        local version=""
        local install_dir=""

        if command -v signal-cli >/dev/null 2>&1; then
            local resolved=""
            resolved=$(readlink -f "$(command -v signal-cli)" 2>/dev/null || true)
            if [[ "$resolved" == /opt/signal-cli-*/bin/signal-cli ]]; then
                return 0
            fi
            echo "signal-cli is installed at ${resolved:-$(command -v signal-cli)} but is not the /opt JVM build; reinstalling..."
        fi

        echo "signal-cli is not installed on the server."
        echo "Installing latest JVM signal-cli..."

        require_cmd curl
        require_cmd tar
        version=$(curl -fsSL -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')

        if [[ -z "$version" ]]; then
            echo "Failed to determine the latest signal-cli version from GitHub." >&2
            exit 1
        fi

        install_dir="$TMP_DIR/signal-cli-install"
        mkdir -p "$install_dir"

        (
            cd "$install_dir"
            curl -fL -O "https://github.com/AsamK/signal-cli/releases/download/v${version}/signal-cli-${version}.tar.gz"

            sudo tar xf "signal-cli-${version}.tar.gz" -C /opt
            sudo ln -sf "/opt/signal-cli-${version}/bin/signal-cli" /usr/local/bin/
        )

        if ! command -v signal-cli >/dev/null 2>&1; then
            echo "signal-cli installation completed but the binary is still not available in PATH." >&2
            exit 1
        fi
    }

    set_signal_mode() {
        local client_id="$1"
        local from_mode="$2"
        local to_mode="$3"

        sudo -u postgres psql -X -d "$PG_DB" -v ON_ERROR_STOP=1 \
            -c "UPDATE echo_client_config SET signal_mode = '${to_mode}' WHERE client_id = ${client_id} AND signal_mode = '${from_mode}';" \
            >/dev/null
    }

    get_signal_mode() {
        local client_id="$1"

        sudo -u postgres psql \
            -X \
            -v ON_ERROR_STOP=1 \
            -d "$PG_DB" \
            -At \
            -c "SELECT signal_mode FROM echo_client_config WHERE client_id = ${client_id};"
    }

    restore_bot() {
        local client_id="$1"
        local unit_name="$2"
        local env_file="$3"
        local env_backup="$4"
        local was_running="$5"

        if [[ -f "$env_backup" ]]; then
            sudo cp "$env_backup" "$env_file" || true
        fi
        set_signal_mode "$client_id" normal native || true
        if [[ "$was_running" == "1" ]]; then
            sudo systemctl restart "$unit_name" >/dev/null 2>&1 || true
        fi
    }

    require_cmd psql
    require_cmd sudo
    require_cmd systemctl
    require_cmd awk
    require_cmd grep
    require_cmd sed

    ensure_compatible_java
    ensure_signal_cli

    mapfile -t running_units < <(systemctl list-units --type=service --state=running 'echo-signal-bot@*' --no-legend --plain | awk '{print $1}')
    declare -A was_running=()
    for unit_name in "${running_units[@]}"; do
        bot_name="${unit_name#echo-signal-bot@}"
        bot_name="${bot_name%.service}"
        was_running["$bot_name"]=1
    done

    candidate_rows=$(
        sudo -u postgres psql \
            -X \
            -v ON_ERROR_STOP=1 \
            -d "$PG_DB" \
            -At \
            -F $'\t' \
            -c "
            SELECT DISTINCT
                ec.id,
                ec.name,
                ea.phone_number,
                ecc.signal_port
            FROM echo_client ec
            JOIN echo_client_config ecc ON ecc.client_id = ec.id
            JOIN echo_client_lock ecl ON ecl.client_id = ec.id
            JOIN echo_account ea ON ea.id = ecl.account_id
            WHERE ec.deleted = false
              AND ecl.remove_requested = false
              AND ea.source = 'signal'
              AND ea.phone_number IS NOT NULL
              AND ecc.signal_mode = 'native'
            ORDER BY ec.name;
        "
    )

    candidates=()
    if [[ -n "$candidate_rows" ]]; then
        mapfile -t candidates <<<"$candidate_rows"
    fi

    if [[ ${#candidates[@]} -eq 0 ]]; then
        echo "No Signal bots remain in native mode; nothing to migrate."
        exit 0
    fi

    echo
    echo "Migration candidates:"
    for row in "${candidates[@]}"; do
        IFS=$'\t' read -r _ bot_name phone_number _ <<<"$row"
        echo "  - $bot_name ($phone_number)"
    done
    echo

    migrated_count=0
    failures=()

    echo "Migrating ${#candidates[@]} Signal bot(s) from native to JVM mode..."

    for row in "${candidates[@]}"; do
        IFS=$'\t' read -r client_id bot_name phone_number signal_port <<<"$row"
        if [[ -z "$bot_name" ]]; then
            failures+=("invalid candidate row")
            continue
        fi

        config_dir="$SIGNAL_ROOT/$bot_name/signal-cli"
        env_file="$SIGNAL_ROOT/$bot_name/$bot_name.env"
        env_backup="$TMP_DIR/$bot_name.env.bak"
        unit_name="echo-signal-bot@$bot_name.service"
        is_running="${was_running[$bot_name]:-0}"
        env_file_exists=0

        echo "--- $bot_name ($phone_number) ---"

        if [[ ! -d "$config_dir" ]]; then
            failures+=("$bot_name: missing Signal config dir $config_dir")
            echo "Missing Signal config dir: $config_dir"
            continue
        fi

        if sudo test -f "$env_file"; then
            env_file_exists=1
        fi

        account_output=$(sudo signal-cli --output=json --data-dir "$config_dir" listAccounts 2>&1 || true)
        if ! grep -Fq "\"$phone_number\"" <<<"$account_output"; then
            failures+=("$bot_name: JVM signal-cli could not read account data for $phone_number :: $account_output")
            echo "JVM preflight failed"
            continue
        fi

        if [[ "$env_file_exists" != "1" ]]; then
            echo "Env file is missing at $env_file; updating database only."
            if ! set_signal_mode "$client_id" native normal; then
                failures+=("$bot_name: failed to update echo_client_config.signal_mode")
                echo "Database update failed"
                continue
            fi

            mode_value=$(get_signal_mode "$client_id")
            account_output=$(sudo signal-cli --output=json --data-dir "$config_dir" listAccounts 2>&1 || true)
            if [[ "$mode_value" != "normal" ]] \
                || ! grep -Fq "\"$phone_number\"" <<<"$account_output"; then
                set_signal_mode "$client_id" normal native || true
                failures+=("$bot_name: database-only post-migration verification failed")
                echo "Database-only verification failed; reverted bot to native mode"
                continue
            fi

            migrated_count=$((migrated_count + 1))
            echo "Database migrated successfully; skipped env/systemd update"
            continue
        fi

        sudo cp "$env_file" "$env_backup"
        printf 'PORT=%s\nMODE=normal\n' "$signal_port" | sudo tee "$env_file" >/dev/null

        if [[ "$is_running" == "1" ]]; then
            if ! sudo systemctl restart "$unit_name"; then
                restore_bot "$client_id" "$unit_name" "$env_file" "$env_backup" "$is_running"
                failures+=("$bot_name: systemd restart failed")
                echo "Restart failed; reverted bot to native mode"
                continue
            fi
            if ! sudo systemctl is-active --quiet "$unit_name"; then
                restore_bot "$client_id" "$unit_name" "$env_file" "$env_backup" "$is_running"
                failures+=("$bot_name: service is not active after restart")
                echo "Service did not return to active state; reverted bot to native mode"
                continue
            fi
        fi

        if ! set_signal_mode "$client_id" native normal; then
            restore_bot "$client_id" "$unit_name" "$env_file" "$env_backup" "$is_running"
            failures+=("$bot_name: failed to update echo_client_config.signal_mode")
            echo "Database update failed; reverted bot to native mode"
            continue
        fi

        mode_value=$(get_signal_mode "$client_id")
        account_output=$(sudo signal-cli --output=json --data-dir "$config_dir" listAccounts 2>&1 || true)
        if ! sudo grep -Fxq 'MODE=normal' "$env_file" \
            || [[ "$mode_value" != "normal" ]] \
            || ! grep -Fq "\"$phone_number\"" <<<"$account_output"; then
            restore_bot "$client_id" "$unit_name" "$env_file" "$env_backup" "$is_running"
            failures+=("$bot_name: post-migration verification failed")
            echo "Verification failed; reverted bot to native mode"
            continue
        fi

        migrated_count=$((migrated_count + 1))
        echo "Migrated successfully"
    done

    echo
    echo "Migration summary: migrated=$migrated_count failed=${#failures[@]}"
    if [[ ${#failures[@]} -gt 0 ]]; then
        printf 'FAILED: %s\n' "${failures[@]}"
        exit 1
    fi

    echo "Signal JVM migration completed successfully."
    EOF

[arg('server', long='server')]
deploy _server_pos="" server:
    #!/bin/bash
    set -euo pipefail
    # Enable tracing if DEBUG=1 or TRACE=1 is set in environment
    if [[ "${DEBUG:-0}" == "1" || "${TRACE:-0}" == "1" ]]; then
      set -x
    fi
    if [[ "{{ _server_pos }}" != "" && "{{ server }}" != "" ]]; then
      echo "pass either positional server or --server, not both." >&2
      exit 1
    fi

    if [[ "{{ _server_pos }}" != "" ]]; then
      SERVER="{{ _server_pos }}"
    elif [[ "{{ server }}" != "" ]]; then
      SERVER="{{ server }}"
    else
      just _print-servers; exit 1;
    fi
    # Determine version from root Cargo.toml ([workspace.package].version)
    VERSION=$(tq -r -f Cargo.toml workspace.package.version)

    if [[ -z "$VERSION" ]]; then
      echo "Failed to detect version from Cargo.toml" >&2
      exit 1
    fi

    STARTED_KEY="echo-ci:deploy:echo:started:$VERSION"
    FINISHED_KEY="echo-ci:deploy:echo:finished:$VERSION"

    # Use SSH to the CI build host and query redis on localhost there.
    # Fixed builder host; can override by setting env BUILDER.
    BUILDER="${BUILDER:-echo-build-main}"
    CI_SSH_TARGET="$BUILDER"
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$CI_SSH_TARGET" true 2>/dev/null; then
      echo "Cannot SSH to $CI_SSH_TARGET; required to check Redis keys" >&2
      exit 1
    fi

    printf "\n🚀🚀🚀 deploying %s 🚀🚀🚀\n\n" "$SERVER"

    # Notify Discord at the start of deployment including local hostname
    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"deploying $SERVER (version $VERSION); waiting for CI from $(hostname)\"}" \
      '{{ discord_webhook_infra }}' || true

    # Helpful link to CI runs
    echo "CI: https://github.com/echoua/echo/actions"

    echo "Waiting up to 15m for CI key: $STARTED_KEY ..."
    ok=0
    # Temporarily disable xtrace inside the polling loop to keep output tidy
    trace_was_on=0; case $- in *x*) trace_was_on=1;; esac; [[ $trace_was_on -eq 1 ]] && set +x
    # 15 minutes total, polling every 5s -> 180 iterations
    for i in $(seq 1 180); do
      exists=$(ssh "$CI_SSH_TARGET" redis-cli EXISTS "$STARTED_KEY")
      if [[ "$exists" == "1" ]]; then ok=1; break; fi
      # keep quiet while polling
      sleep 5
      echo -n "."
    done
    [[ $trace_was_on -eq 1 ]] && set -x
    echo
    if [[ $ok -ne 1 ]]; then
      echo "CI did not start publishing for version $VERSION within 60s (key $STARTED_KEY missing)" >&2
      exit 1
    fi

    echo "CI started detected. Waiting up to 10m for finish key: $FINISHED_KEY ..."
    trace_was_on=0; case $- in *x*) trace_was_on=1;; esac; [[ $trace_was_on -eq 1 ]] && set +x
    done_ok=0
    # 10 minutes total, polling every 5s -> 120 iterations
    for i in $(seq 1 120); do
      exists=$(ssh "$CI_SSH_TARGET" redis-cli EXISTS "$FINISHED_KEY")
      if [[ "$exists" == "1" ]]; then done_ok=1; break; fi
      # keep quiet while polling
      sleep 5
      echo -n "."
    done
    [[ $trace_was_on -eq 1 ]] && set -x
    echo
    if [[ $done_ok -ne 1 ]]; then
      echo "CI did not finish publishing for version $VERSION within 10m (key $FINISHED_KEY missing)" >&2
      exit 1
    fi

    echo "CI finished detected. Proceeding with remote apt install."
    ssh "$SERVER" 'set -euo pipefail
      if ! command -v java >/dev/null 2>&1; then
        echo "ERROR: Java is required for Signal normal mode, but java is not installed." >&2
        echo "Install Java 25+ on $HOSTNAME before deploying." >&2
        exit 1
      fi
      java_major=$(java -version 2>&1 | head -1 | grep -oE "[0-9]+" | head -1)
      if [ -z "$java_major" ] || [ "$java_major" -lt 25 ]; then
        echo "ERROR: Signal normal mode requires Java 25+, found: $(java -version 2>&1 | head -1)" >&2
        exit 1
      fi
      echo "Java preflight OK: $(java -version 2>&1 | head -1)"
    '
    ssh "$SERVER" 'set -euo pipefail
      if systemctl cat wdintel-rs-bgworker.service >/dev/null 2>&1; then
        echo "Stopping wdintel-rs-bgworker.service and waiting up to 120 seconds..."
        sudo systemctl stop wdintel-rs-bgworker.service || true
        for i in $(seq 1 120); do
          if ! systemctl is-active --quiet wdintel-rs-bgworker.service; then
            echo "wdintel-rs-bgworker.service is stopped."
            break
          fi
          if [ "$i" -eq 120 ]; then
            echo "wdintel-rs-bgworker.service did not stop within 120 seconds." >&2
            exit 1
          fi
          sleep 1
        done
      else
        echo "wdintel-rs-bgworker.service is not installed; skipping stop wait."
      fi'
    # Keep apt mostly quiet, but print the command before running it and fail on timeouts.
    ssh "$SERVER" 'set -euo pipefail
      run_logged() {
        local timeout_secs="$1"
        local command_text="$2"
        shift 2

        echo "+ $command_text"
        local status=0
        if timeout --foreground "${timeout_secs}s" "$@"; then
          status=0
        else
          status="$?"
        fi
        if [ "$status" -eq 0 ]; then
          return 0
        fi

        if [ "$status" -eq 124 ]; then
          echo "$command_text timed out after ${timeout_secs}s." >&2
        else
          echo "$command_text failed with exit code $status." >&2
        fi
        return "$status"
      }

      run_logged 600 "sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update" \
        sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update
      run_logged 1200 "sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Lock::Timeout=120 -y -qq install echo-install wdintel-rs" \
        sudo env DEBIAN_FRONTEND=noninteractive \
          apt-get -o Dpkg::Lock::Timeout=120 -y -qq install echo-install wdintel-rs'

    # Re-assert critical services after deploy package update
    ssh "$SERVER" '
      set -euo pipefail

      sudo systemctl daemon-reload
      sudo systemctl disable --now wdintel-rs.service || true

      # Leave only wdintel-rs.socket on :8081; clean up legacy/generated sockets.
      for unit in wdintel-rs-bgworker.socket wdintel-py.socket echo-vector.socket; do
        if systemctl cat "$unit" >/dev/null 2>&1; then
          sudo systemctl disable --now "$unit" || true
        fi
      done
      for unit in $(sudo systemctl list-units --all --no-legend --full "echo-signal-bot@*.socket" "echo-whatsapp-bot@*.socket" | awk "{print \$1}"); do
        sudo systemctl disable --now "$unit" || true
      done

      sudo systemctl enable --now wdintel-rs.socket
      sudo systemctl enable --now wdintel-rs-bgworker.service
      sudo systemctl enable --now wdintel-py.service

      for unit in wdintel-rs.socket wdintel-rs-bgworker.service wdintel-py.service; do
        if ! systemctl is-enabled --quiet "$unit"; then
          echo "ERROR: $unit is not enabled after deploy." >&2
          systemctl is-enabled "$unit" || true
          exit 1
        fi
      done

      if ! systemctl is-active --quiet wdintel-rs-bgworker.service; then
        echo "ERROR: wdintel-rs-bgworker.service is not active after deploy." >&2
        systemctl status --no-pager wdintel-rs-bgworker.service || true
        exit 1
      fi
      if ! systemctl is-active --quiet wdintel-py.service; then
        echo "ERROR: wdintel-py.service is not active after deploy." >&2
        systemctl status --no-pager wdintel-py.service || true
        exit 1
      fi
      if ! systemctl is-active --quiet wdintel-rs.socket; then
        echo "ERROR: wdintel-rs.socket is not active on 8081." >&2
        systemctl status --no-pager wdintel-rs.socket || true
        exit 1
      fi

      listen_8081=$(sudo ss -ltnp | grep "LISTEN .*:8081" || true)
      if [ -z "$listen_8081" ]; then
        echo "ERROR: 8081 is not listening after deploy." >&2
        sudo ss -ltnp | grep "LISTEN" | grep ":8081" || true
        exit 1
      fi
      if ! printf "%s\n" "$listen_8081" | grep -q "systemd"; then
        echo "ERROR: 8081 is bound by unexpected process after deploy." >&2
        printf "%s\n" "$listen_8081"
        exit 1
      fi
    '
    printf "\n⚠️⚠️⚠️ docs were not deployed. Run: just deploy-docs --server %s ⚠️⚠️⚠️\n" "$SERVER"
    echo "✅✅✅ deploy OK on $SERVER: wdintel-rs.socket, wdintel-rs-bgworker.service, wdintel-py.service, 8081 via systemd ✅✅✅"

    # Success notification
    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"✅ Deployed $SERVER (version $VERSION) via apt-get\"}" \
      '{{ discord_webhook_infra }}' || true

[arg('server', long='server')]
deploy-from-local _server_pos="" server:
    #!/bin/bash
    set -euo pipefail
    if [[ "${DEBUG:-0}" == "1" || "${TRACE:-0}" == "1" ]]; then
      set -x
    fi
    if [[ "{{ _server_pos }}" != "" && "{{ server }}" != "" ]]; then
      echo "pass either positional server or --server, not both." >&2
      exit 1
    fi

    if [[ "{{ _server_pos }}" != "" ]]; then
      SERVER="{{ _server_pos }}"
    elif [[ "{{ server }}" != "" ]]; then
      SERVER="{{ server }}"
    else
      just _print-servers; exit 1;
    fi

    DEB_PATH=""
    DEB_NAME=""

    printf "\n🚀🚀🚀 deploying %s from local .deb 🚀🚀🚀\n\n" "$SERVER"

    echo "Building frontend assets..."
    (cd "{{ justfile_directory() }}" && just build-front)

    echo "Building local wdintel-rs deb package..."
    (cd "{{ justfile_directory() }}" && cargo deb -p wdintel-rs --fast)

    DEB_PATH="$(ls -1t "{{ justfile_directory() }}"/target/debian/wdintel-rs_*_*.deb | head -n 1)"
    if [[ -z "$DEB_PATH" ]]; then
      echo "Failed to find built wdintel-rs .deb in target/debian" >&2
      exit 1
    fi
    DEB_NAME="$(basename "$DEB_PATH")"
    REMOTE_DEB_NAME="${DEB_NAME%.deb}-local-$(date -u +%Y%m%d%H%M%S)-$$.deb"
    REMOTE_DEB_PATH="/var/tmp/${REMOTE_DEB_NAME}"
    RESTART_BGWORKER_ON_FAILURE=0

    cleanup() {
      local status=$?
      trap - EXIT

      if [[ -n "$REMOTE_DEB_PATH" ]]; then
        ssh "$SERVER" "rm -f -- '$REMOTE_DEB_PATH'" >/dev/null 2>&1 || true
      fi
      if [[ $status -ne 0 && $RESTART_BGWORKER_ON_FAILURE -eq 1 ]]; then
        echo "Deployment failed; restarting wdintel-rs-bgworker.service..." >&2
        if ! ssh "$SERVER" 'sudo systemctl start wdintel-rs-bgworker.service'; then
          echo "Failed to restart wdintel-rs-bgworker.service after deployment failure." >&2
        fi
      fi

      exit "$status"
    }
    trap cleanup EXIT

    echo "Uploading ${DEB_NAME} to ${SERVER}:${REMOTE_DEB_PATH}..."
    scp "$DEB_PATH" "${SERVER}:${REMOTE_DEB_PATH}"

    RESTART_BGWORKER_ON_FAILURE=1
    ssh "$SERVER" 'set -euo pipefail
      if ! command -v java >/dev/null 2>&1; then
        echo "ERROR: Java is required for Signal normal mode, but java is not installed." >&2
        echo "Install Java 25+ on $HOSTNAME before deploying." >&2
        exit 1
      fi
      java_major=$(java -version 2>&1 | head -1 | grep -oE "[0-9]+" | head -1)
      if [ -z "$java_major" ] || [ "$java_major" -lt 25 ]; then
        echo "ERROR: Signal normal mode requires Java 25+, found: $(java -version 2>&1 | head -1)" >&2
        exit 1
      fi
      echo "Java preflight OK: $(java -version 2>&1 | head -1)"
    '
    ssh "$SERVER" 'set -euo pipefail
      if systemctl cat wdintel-rs-bgworker.service >/dev/null 2>&1; then
        echo "Stopping wdintel-rs-bgworker.service and waiting up to 120 seconds..."
        sudo systemctl stop wdintel-rs-bgworker.service || true
        for i in $(seq 1 120); do
          if ! systemctl is-active --quiet wdintel-rs-bgworker.service; then
            echo "wdintel-rs-bgworker.service is stopped."
            break
          fi
          if [ "$i" -eq 120 ]; then
            echo "wdintel-rs-bgworker.service did not stop within 120 seconds." >&2
            exit 1
          fi
          sleep 1
        done
      else
        echo "wdintel-rs-bgworker.service is not installed; skipping stop wait."
      fi'

    echo "Installing ${DEB_NAME} on ${SERVER}..."
    ssh "$SERVER" "set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      cd /var/tmp
      if ! sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Lock::Timeout=120 -y -qq install --reinstall --allow-downgrades './${REMOTE_DEB_NAME}'; then
        echo 'Initial local package install failed; updating APT indexes and retrying...'
        sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update
        sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Lock::Timeout=120 -y -qq install --reinstall --allow-downgrades './${REMOTE_DEB_NAME}'
      fi
      rm -f './${REMOTE_DEB_NAME}'
    "
    REMOTE_DEB_PATH=""

    ssh "$SERVER" '
      set -euo pipefail

      sudo systemctl daemon-reload
      sudo systemctl disable --now wdintel-rs.service || true

      for unit in wdintel-rs-bgworker.socket wdintel-py.socket echo-vector.socket; do
        if systemctl cat "$unit" >/dev/null 2>&1; then
          sudo systemctl disable --now "$unit" || true
        fi
      done
      for unit in $(sudo systemctl list-units --all --no-legend --full "echo-signal-bot@*.socket" "echo-whatsapp-bot@*.socket" | awk "{print \$1}"); do
        sudo systemctl disable --now "$unit" || true
      done

      sudo systemctl enable --now wdintel-rs.socket
      sudo systemctl enable --now wdintel-rs-bgworker.service

      for unit in wdintel-rs.socket wdintel-rs-bgworker.service; do
        if ! systemctl is-enabled --quiet "$unit"; then
          echo "ERROR: $unit is not enabled after deploy." >&2
          systemctl is-enabled "$unit" || true
          exit 1
        fi
      done

      if ! systemctl is-active --quiet wdintel-rs-bgworker.service; then
        echo "ERROR: wdintel-rs-bgworker.service is not active after deploy." >&2
        systemctl status --no-pager wdintel-rs-bgworker.service || true
        exit 1
      fi
      if ! systemctl is-active --quiet wdintel-rs.socket; then
        echo "ERROR: wdintel-rs.socket is not active on 8081." >&2
        systemctl status --no-pager wdintel-rs.socket || true
        exit 1
      fi

      listen_8081=$(sudo ss -ltnp | grep "LISTEN .*:8081" || true)
      if [ -z "$listen_8081" ]; then
        echo "ERROR: 8081 is not listening after deploy." >&2
        sudo ss -ltnp | grep "LISTEN" | grep ":8081" || true
        exit 1
      fi
      if ! printf "%s\n" "$listen_8081" | grep -q "systemd"; then
        echo "ERROR: 8081 is bound by unexpected process after deploy." >&2
        printf "%s\n" "$listen_8081"
        exit 1
      fi

      echo "✅✅✅ deploy OK on $HOSTNAME: wdintel-rs.socket, wdintel-rs-bgworker.service, 8081 via systemd ✅✅✅"
    '
    RESTART_BGWORKER_ON_FAILURE=0

[arg('server', long='server')]
deploy-docs-from-local _server_pos="" server:
    #!/bin/bash
    set -euo pipefail
    if [[ "${DEBUG:-0}" == "1" || "${TRACE:-0}" == "1" ]]; then
      set -x
    fi
    if [[ "{{ _server_pos }}" != "" && "{{ server }}" != "" ]]; then
      echo "pass either positional server or --server, not both." >&2
      exit 1
    fi

    if [[ "{{ _server_pos }}" != "" ]]; then
      SERVER="{{ _server_pos }}"
    elif [[ "{{ server }}" != "" ]]; then
      SERVER="{{ server }}"
    else
      just _print-servers; exit 1;
    fi

    DEB_DIR="{{ justfile_directory() }}/target/debian"
    DEB_PATH=""
    REMOTE_DEB_PATH=""

    printf "\n📚📚📚 deploying docs %s from local .deb 📚📚📚\n\n" "$SERVER"

    echo "Building docs site..."
    (cd "{{ justfile_directory() }}" && just docs)

    echo "Building local echo-docs deb package..."
    mkdir -p "$DEB_DIR"
    find "$DEB_DIR" -maxdepth 1 -type f -name 'echo-docs_*.deb' -delete
    (cd "{{ justfile_directory() }}/docs/echo-docs" && cargo deb --fast)

    DEB_PATH="$(ls -1t "$DEB_DIR"/echo-docs_*_*.deb | head -n 1)"
    if [[ -z "$DEB_PATH" ]]; then
      echo "Failed to find built echo-docs .deb in $DEB_DIR" >&2
      exit 1
    fi
    DEB_NAME="$(basename "$DEB_PATH")"
    REMOTE_DEB_NAME="${DEB_NAME%.deb}-local-$(date -u +%Y%m%d%H%M%S)-$$.deb"
    REMOTE_DEB_PATH="/var/tmp/${REMOTE_DEB_NAME}"

    cleanup() {
      local status=$?
      trap - EXIT

      if [[ -n "$REMOTE_DEB_PATH" ]]; then
        ssh "$SERVER" "rm -f -- '$REMOTE_DEB_PATH'" >/dev/null 2>&1 || true
      fi

      exit "$status"
    }
    trap cleanup EXIT

    echo "Uploading ${DEB_NAME} to ${SERVER}:${REMOTE_DEB_PATH}..."
    scp "$DEB_PATH" "${SERVER}:${REMOTE_DEB_PATH}"

    echo "Installing ${DEB_NAME} on ${SERVER}..."
    ssh "$SERVER" "set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      cd /var/tmp
      if ! sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Lock::Timeout=120 -y -qq install --reinstall --allow-downgrades './${REMOTE_DEB_NAME}'; then
        echo 'Initial local package install failed; updating APT indexes and retrying...'
        sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update
        sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Lock::Timeout=120 -y -qq install --reinstall --allow-downgrades './${REMOTE_DEB_NAME}'
      fi
      rm -f './${REMOTE_DEB_NAME}'

      installed=\$(dpkg-query -W -f='\${Version}' echo-docs)
      echo "✅✅✅ docs deploy OK on \$HOSTNAME: echo-docs \$installed ✅✅✅"
    "
    REMOTE_DEB_PATH=""

collect-ip-loop:
    #!/bin/bash
    set -euxo pipefail
    mkdir ~/ips || echo 'already exists'
    just server="hammer" _collect-ip;
    just server="jvln" _collect-ip;
    just server="echo-kherson" _collect-ip;
    just server="echo-volyn" _collect-ip;
    just server="echo-donetsk" _collect-ip;
    just server="echo-zaporizhzha" _collect-ip;
    just server="echo-kharkiv" _collect-ip;
    just server="echo-soledarnist" _collect-ip;
    just server="echo-lyman" _collect-ip;
    just server="echo-sumy2" _collect-ip;
    cat ~/ips/ips.txt
    rm ~/ips/ips.txt

update-nginx-loop:
    #!/bin/bash
    set -euxo pipefail
    just server="echo-kherson" _update-nginx;
    just server="echo-volyn" _update-nginx;
    just server="echo-donetsk" _update-nginx;
    just server="echo-zaporizhzha" _update-nginx;
    just server="echo-kharkiv" _update-nginx;
    just server="echo-soledarnist" _update-nginx;
    just server="echo-lyman" _update-nginx;
    just server="echo-sumy2" _update-nginx;

_collect-ip:
    #!/bin/bash
    ssh -t {{ server }}  'echo {{ server }} > ~/myip.txt'
    ssh -t {{ server }}  'curl -4 ifconfig.me >> ~/myip.txt'
    scp {{ server }}:~/myip.txt ~/ips/{{ server }}-ip.txt
    cat ~/ips/{{ server }}-ip.txt >> ~/ips/ips.txt
    echo "" >> ~/ips/ips.txt
    rm ~/ips/{{ server }}-ip.txt

_update-nginx:
    #!/bin/bash
    scp ./deploy/nginx/{{ server }} {{ server }}:~
    ssh -t {{ server }}  'cd /etc/nginx/sites-enabled && sudo cp {{ server }} ~/_{{ server }}-nginx-bkp'
    ssh -t {{ server }}  'sudo mv ~/{{ server }} /etc/nginx/sites-enabled && sudo systemctl restart nginx'
    ssh -t {{ server }}  'sudo rm ~/_{{ server }}-nginx-bkp'

[arg('server', long='server')]
copy-db server:
    #!/bin/bash
    set -euxo pipefail

    case "{{ server }}" in
        jvln)
            just _jvln-copy-db
            ;;
        echo-zaporizhzha|echo-kherson|echo-donetsk2|echo-soledar|echo-soledarnist|echo-lyman|echo-kharkiv|echo-siversk|echo-kherson2|echo-volyn2|echo-pivnich|echo-pivnich-dev|echo-skhid|echo-kupiansk|echo-zp2|echo-staging|echo-cbr)
            just server="{{ server }}" dt1="{{ dt1 }}" _copy-db
            ;;
        *)
            just server="{{ server }}" _print-servers
            exit 1
            ;;
    esac
    { set +x; } 2>/dev/null
    if [[ -f /etc/echo-peerdb/source.env ]] \
      || sudo -n test -f /etc/echo-peerdb/source.env 2>/dev/null; then
        cat <<'COMMANDS'

    # PeerDB is configured. This block is safe to paste all at once.
    deploy/restore-copied-db.sh --yes /var/tmp/wd-{{ dt1 }}.pgrestore

    # Optional but recommended when copying a live/staging database into dev:
    cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im-and-goi

    COMMANDS
    else
        cat <<'COMMANDS'

    # PostgreSQL-only restore. This block is safe to paste all at once.
    sudo -u postgres dropdb --force wd
    sudo -u postgres psql postgres -c "CREATE DATABASE wd"
    sudo -u postgres pg_restore -d wd /var/tmp/wd-{{ dt1 }}.pgrestore

    # Optional but recommended when copying a live/staging database into dev:
    cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im-and-goi

    COMMANDS
    fi

[arg('dump', long='dump')]
restore-copied-db dump:
    deploy/restore-copied-db.sh "{{ dump }}"

# _jvln-copy-db:
#     ssh -t jvln '(cd /fast/kon/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
#     scp jvln:/fast/kon/Downloads/wd-{{ dt1 }}.pgrestore /tmp
#     ssh -t jvln 'rm /fast/kon/Downloads/wd-{{ dt1 }}.pgrestore'
#     sudo -u postgres dropdb --force wd
#     sudo -u postgres psql -c "CREATE DATABASE wd" postgres
#     sudo -u postgres pg_restore -d wd /tmp/wd-{{ dt1 }}.pgrestore

_copy-db:
    #!/bin/bash
    set -euxo pipefail

    ssh -t {{ server }} '(cd /var/tmp && PGPASSWORD="{{ pgpwd }}" pg_dump --host 127.0.0.1 --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    scp {{ server }}:/var/tmp/wd-{{ dt1 }}.pgrestore /var/tmp/
    ssh -t {{ server }} 'rm /var/tmp/wd-{{ dt1 }}.pgrestore'

ai-sync-from-cloud:
    #!/bin/bash
    if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
        # readonly default keys
        export AWS_ACCESS_KEY_ID='003f325aff5dd5c000000001c'
        export AWS_SECRET_ACCESS_KEY='K003uL32BhqEzo+9UCp+kOFUvTVoPfg'
    fi
    if ! command -v s5cmd >/dev/null 2>&1; then
        echo "❌ s5cmd is required to ai models (https://github.com/peak/s5cmd)"
        exit 1
    fi

    BUCKET_PREFIX="{{ ai_bucket_prefix }}"
    ENDPOINT_URL="{{ b2_endpoint_url }}"
    WD_FASTTEXT_MODELS="{{ wd_fasttext_models }}"

    remote_files="${BUCKET_PREFIX}/*"
    local_directory="${WD_FASTTEXT_MODELS}/"
    s5cmd --endpoint-url "$ENDPOINT_URL" cp --if-source-newer --show-progress "$remote_files" "$local_directory"

# run like `just copy-db-backup echo-zp2`
[arg('server', long='server')]
copy-db-backup server:
    #!/bin/bash
    set -euo pipefail
    scripts/copy-db-backup.sh "{{ server }}"

copy-db-gpu:
    #!/bin/bash
    set -euxo pipefail
    echo 'please use just copy-db-pivnich or just pgdb=wd_rat copy-db-pivnich'
    exit 1

# copy-db via replica onto dev
# param server: source replica (example: echo-pivnich-replica)
# param target: destination (example: echo-pivnich-dev)
#
# SETUP
# - gen keys on dev: `ssh-keygen -t ed25519 -a 100 -C backup@localhost`
# - put pub in ~/.ssh/authorized_keys on replica

# - edit ~/.ssh/config on dev, add $SERVER entry
copy-db-dev:
    #!/bin/bash
    set -euxo pipefail
    . deploy/utils.sh
    ensure_nonempty "server" "{{ server }}"
    ensure_nonempty "target" "{{ target }}"
    SERVER="{{ server }}"
    TARGET="{{ target }}"
    ssh -t $SERVER "sudo -u postgres psql -c 'SELECT pg_wal_replay_pause();'"
    ssh -t $SERVER '(cd /var/tmp && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    ssh -t $SERVER "sudo -u postgres psql -c 'SELECT pg_wal_replay_resume();'"
    ssh -t $TARGET "rsync $SERVER:/var/tmp/wd-{{ dt1 }}.pgrestore /var/tmp/"
    ssh -t $SERVER '(rm /var/tmp/wd-{{ dt1 }}.pgrestore) | echo "ok"'
    ssh -t $TARGET "sudo -u postgres psql -c 'drop database {{ pgdb }} with (FORCE)' | echo 'ok'"
    ssh -t $TARGET "sudo -u postgres psql -c 'create database {{ pgdb }}'"
    ssh -t $TARGET "sudo -u postgres pg_restore -d {{ pgdb }} /var/tmp/wd-{{ dt1 }}.pgrestore && sudo rm /var/tmp/wd-{{ dt1 }}.pgrestore"
    echo "⭐ You can disable messengers and GOI sync by running: cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im-and-goi"

copy-db-to-target:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    if [[ "{{ target }}" == "" ]]; then
        echo "❌ `target` parameter not recognized. Value: {{ target }}"; exit 1;
    fi
    ssh -t {{ server }} '(cd /var/tmp && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    ssh -t {{ server }} 'gzip -c /var/tmp/wd-{{ dt1 }}.pgrestore > /tmp/wd-{{ dt1 }}.pgrestore.gz'
    scp {{ server }}:/tmp/wd-{{ dt1 }}.pgrestore.gz /var/tmp/
    ssh -t {{ server }} '(rm /var/tmp/wd-{{ dt1 }}.pgrestore && rm /tmp/wd-{{ dt1 }}.pgrestore.gz) | echo "ok"'
    scp /var/tmp/wd-{{ dt1 }}.pgrestore.gz {{ target }}:/var/tmp/
    ssh -t {{ target }} '(cd /var/tmp && gunzip wd-{{ dt1 }}.pgrestore.gz)'
    ssh -t {{ target }} "sudo -u postgres psql -c 'drop database {{ pgdb }} with (FORCE)'"
    ssh -t {{ target }} "sudo -u postgres psql -c 'create database {{ pgdb }}'"
    ssh -t {{ target }} "sudo -u postgres pg_restore -d {{ pgdb }} /var/tmp/wd-{{ dt1 }}.pgrestore && sudo rm /var/tmp/wd-{{ dt1 }}.pgrestore"
    rm /var/tmp/wd-{{ dt1 }}.pgrestore.gz | echo "ok"

# restore postgres via pgBackRest: runs on `--server`; `--backup-name` selects which host's backups will be restored (defaults to `--server`)
[arg('backup_name', long='backup-name')]
[arg('server', long='server')]
restore-pgbackrest server backup_name="":
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    TARGET="{{ server }}"
    BACKUP_NAME="{{ backup_name }}"
    if [[ -z "${BACKUP_NAME}" ]]; then
      BACKUP_NAME="${TARGET}"
    fi
    ssh "$TARGET" 'sudo echo-install-utils install-pgbackrest'
    ssh "$TARGET" 'sudo install -d -m 0755 /usr/local/sbin'
    ssh "$TARGET" 'sudo tee /usr/local/sbin/pgbackrest-safe-restore >/dev/null && sudo chown root:root /usr/local/sbin/pgbackrest-safe-restore && sudo chmod 0755 /usr/local/sbin/pgbackrest-safe-restore' < deploy/postgresql/pgbackrest-safe-restore.sh
    ssh "$TARGET" "sudo SERVER_KEY='${BACKUP_NAME}' bash -s" <<'REMOTE'
        set -euo pipefail

        conf_candidates=(
          "/etc/pgbackrest/conf.d/pgbackrest-${SERVER_KEY}.conf"
          "/etc/pgbackrest/conf.d/pgbackrest-wd-${SERVER_KEY}.conf"
        )
        CONF_FILE=""
        for c in "${conf_candidates[@]}"; do
          if [[ -f "${c}" ]]; then
            CONF_FILE="${c}"
            break
          fi
        done
        if [[ -z "${CONF_FILE}" ]]; then
          echo "" >&2
          echo "############################################################" >&2
          echo "# Missing pgBackRest config on target" >&2
          echo "# tried:" >&2
          printf '# - %s\n' "${conf_candidates[@]}" >&2
          echo "# server: ${SERVER_KEY} (config key)" >&2
          echo "# action: run: just setup-pgbackrest --server $(hostname) --backup-name ${SERVER_KEY}" >&2
          echo "############################################################" >&2
          echo "" >&2
          exit 1
        fi

        STANZA="$(
          awk '
            {
              line=$0
              sub(/^[[:space:]]+/, "", line)
              sub(/[[:space:]]+$/, "", line)
              if (line ~ /^\[/ && line ~ /\]$/) {
                s = substr(line, 2, length(line) - 2)
                if (s !~ /^global(:|$)/) { print s; exit }
              }
            }
          ' "${CONF_FILE}" || true
        )"
        if [[ -z "${STANZA}" ]]; then
          echo "failed to detect stanza from ${CONF_FILE}" >&2
          exit 1
        fi
        echo "stanza=${STANZA}"

        CONF=/etc/pgbackrest/pgbackrest.conf
        if [[ ! -f "${CONF}" ]]; then
          echo "missing ${CONF} on target; run setup-pgbackrest first" >&2
          exit 1
        fi

        sudo /usr/local/sbin/pgbackrest-safe-restore "${STANZA}"
    REMOTE

copy-db-local:
    #!/bin/bash
    set -euxo pipefail
    just dt1={{ dt1 }} pgdb={{ pgdb }} copy-db-download
    just dt1={{ dt1 }} pgdb={{ pgdb }} restore-db-local
    sudo rm /var/tmp/wd-{{ dt1 }}.pgrestore
    ssh -t {{ server }} '(rm /var/tmp/wd-{{ dt1 }}.pgrestore) | echo "ok"'

copy-db-download:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
         just _print-servers; exit 1;
    fi
    echo 'this command requires sudo access'
    sudo ls
    ssh -t {{ server }} '(cd /var/tmp && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    scp {{ server }}:/var/tmp/wd-{{ dt1 }}.pgrestore /var/tmp/
    ssh -t {{ server }} '(rm ~/Downloads/wd-{{ dt1 }}.pgrestore) | echo "ok"'

restore-db-local:
    sudo -u postgres psql -c 'drop database {{ pgdb }} with (FORCE)' | echo 'ok'
    sudo -u postgres psql -c 'create database {{ pgdb }}'
    sudo -u postgres pg_restore -d {{ pgdb }} /var/tmp/wd-{{ dt1 }}.pgrestore

setup-b2:
    ssh {{ server }} 'sudo pip3 install -U b2'

# before running, make sure to read/setup "Backups" section in server.md

# also run just setup-b2
[arg('server', long='server')]
backup-legacy server:
    ssh -t {{ server }} '(cd ~/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ server }}-{{ dt1 }}.pgrestore && ls -lah wd-{{ server }}-{{ dt1 }}.pgrestore)'
    ssh -t {{ server }} '(cd ~/Downloads && sudo gpg --encrypt --recipient 'Echo' wd-{{ server }}-{{ dt1 }}.pgrestore && ls -lah wd-{{ server }}-{{ dt1 }}.pgrestore.gpg)'
    ssh -t {{ server }} 'sudo chown $USER:$USER ~/Downloads/wd-{{ server }}-{{ dt1 }}.pgrestore.gpg'
    ssh -t {{ server }} '(cd ~/Downloads && B2_APPLICATION_KEY_ID={{ backup_key_id }} B2_APPLICATION_KEY={{ backup_key }} b2 upload-file echouabackup ./wd-{{ server }}-{{ dt1 }}.pgrestore.gpg backup/wd-{{ server }}-{{ dt1 }}.pgrestore.gpg)'
    ssh -t {{ server }} 'rm ~/Downloads/wd-{{ server }}-{{ dt1 }}.pgrestore.gpg'
    ssh -t {{ server }} 'rm ~/Downloads/wd-{{ server }}-{{ dt1 }}.pgrestore'

[arg('server', long='server')]
[arg('backup_type', long='type')]
backup server backup_type="":
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    set +x
    echo ""
    echo "############################################################"
    echo "🗄️  pgBackRest backup: {{ server }}"
    echo "############################################################"
    echo ""
    set -x
    ssh {{ server }} 'sudo bash -s' <<'REMOTE'
        set -euo pipefail

        CONF="/etc/pgbackrest/pgbackrest.conf"
        if [[ ! -f "${CONF}" ]]; then
          echo "" >&2
          echo "############################################################" >&2
          echo "# Missing pgBackRest config on server" >&2
          echo "# file: ${CONF}" >&2
          echo "# action: run: just setup-pgbackrest --server {{ server }}" >&2
          echo "############################################################" >&2
          echo "" >&2
          exit 1
        fi

        shopt -s nullglob
        files=(/etc/pgbackrest/conf.d/pgbackrest-*.conf)
        if [[ "${#files[@]}" -eq 0 ]]; then
          echo "" >&2
          echo "############################################################" >&2
          echo "# Missing pgBackRest stanza config on server" >&2
          echo "# dir: /etc/pgbackrest/conf.d" >&2
          echo "# action: run: just setup-pgbackrest --server {{ server }}" >&2
          echo "############################################################" >&2
          echo "" >&2
          exit 1
        fi
        if [[ "${#files[@]}" -ne 1 ]]; then
          echo "" >&2
          echo "############################################################" >&2
          echo "# Multiple pgBackRest stanza configs found on server" >&2
          echo "# dir: /etc/pgbackrest/conf.d" >&2
          echo "# action: specify stanza explicitly on the server, then re-run" >&2
          echo "############################################################" >&2
          ls -lah /etc/pgbackrest/conf.d >&2 || true
          echo "" >&2
          exit 1
        fi
        CONF_FILE="${files[0]}"

        STANZA="$(
          sed -nE 's/^[[:space:]]*\[([^]]+)\][[:space:]]*$/\1/p' "${CONF_FILE}" \
            | grep -vE '^global(:|$)' \
            | head -n 1 || true
        )"
        if [[ -z "${STANZA}" ]]; then
          echo "failed to detect stanza from ${CONF_FILE}" >&2
          exit 1
        fi
        echo "stanza=${STANZA}"

        type_args=()
        if [[ "{{ backup_type }}" != "" ]]; then
          type_args+=(--type "{{ backup_type }}")
        fi

        sudo -u postgres pgbackrest --config="${CONF}" --config-include-path=/etc/pgbackrest/conf.d --stanza="${STANZA}" --log-level-console=info "${type_args[@]}" backup
    REMOTE

[arg('servers', long='servers')]
backup-many _servers_pos="" servers="":
    #!/bin/bash
    set -euo pipefail
    if [[ "{{ _servers_pos }}" != "" ]]; then
      echo "positional servers are not allowed; use: just backup-many --servers=\"echo-staging echo-kherson2 ...\"" >&2
      exit 1
    fi
    if [[ "{{ servers }}" == "" ]]; then
      echo "missing --servers. usage: just backup-many --servers=\"echo-staging echo-kherson2 ...\"" >&2
      exit 1
    fi

    if ! command -v echo-install-utils >/dev/null 2>&1; then
      echo "missing echo-install-utils in PATH (install it or deploy it first)" >&2
      exit 1
    fi

    echo-install-utils run-many \
      --values "{{ servers }}" \
      --cwd "{{ justfile_directory() }}" \
      -- just backup --server={}

[arg('servers', long='servers')]
deploy-many _servers_pos="" servers="":
    #!/bin/bash
    set -euo pipefail
    if [[ "{{ _servers_pos }}" != "" ]]; then
      echo "positional servers are not allowed; use: just deploy-many --servers=\"echo-staging echo-kherson2 ...\"" >&2
      exit 1
    fi
    if [[ "{{ servers }}" == "" ]]; then
      echo "missing --servers. usage: just deploy-many --servers=\"echo-staging echo-kherson2 ...\"" >&2
      exit 1
    fi

    if ! command -v echo-install-utils >/dev/null 2>&1; then
      echo "missing echo-install-utils in PATH (install it or deploy it first)" >&2
      exit 1
    fi

    echo "Each server deploy waits up to 120s for wdintel-rs-bgworker.service to stop, then prints the apt commands it is waiting on."
    echo "Docs are not deployed by deploy-many; use: just deploy-docs-many --servers=\"{{ servers }}\""
    echo-install-utils run-many \
      --values "{{ servers }}" \
      --cwd "{{ justfile_directory() }}" \
      -- just deploy --server={}

[arg('servers', long='servers')]
deploy-docs-many _servers_pos="" servers="":
    #!/bin/bash
    set -euo pipefail
    if [[ "{{ _servers_pos }}" != "" ]]; then
      echo "positional servers are not allowed; use: just deploy-docs-many --servers=\"echo-staging echo-kherson2 ...\"" >&2
      exit 1
    fi
    if [[ "{{ servers }}" == "" ]]; then
      echo "missing --servers. usage: just deploy-docs-many --servers=\"echo-staging echo-kherson2 ...\"" >&2
      exit 1
    fi

    if ! command -v echo-install-utils >/dev/null 2>&1; then
      echo "missing echo-install-utils in PATH (install it or deploy it first)" >&2
      exit 1
    fi

    echo "Each server docs deploy waits for the same CI publish keys as deploy, then apt-installs echo-docs."
    echo-install-utils run-many \
      --values "{{ servers }}" \
      --cwd "{{ justfile_directory() }}" \
      -- just deploy-docs --server={}

_echo-generic-deploy:
    #!/bin/bash
    set -euxo pipefail
    set +x | echo 'skipping set +x, probably ubuntu build'
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    ssh {{ server }} 'sudo apt-get update'
    ssh {{ server }} 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y echo-install wdintel-rs'

_echo-generic-deploy-front:
    ssh {{ builder }} '(cd workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh {{ builder }} '(cd workspace/echo/wdintel-web && . ~/.nvm/nvm.sh && npx npm ci && npm run build)'

_echo-generic-build-rs: prepare-workspace
    ssh {{ builder }} '(cd workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh {{ builder }} '(cd workspace/echo && just prepare-workspace)'
    ssh {{ builder }} '(cd workspace/echo && touch wdintel-rs/build.rs && $HOME/.cargo/bin/cargo deb -p wdintel-rs --fast)'

    # TODO: determine version from Cargo.toml
    rsync --progress {{ builder }}:workspace/echo/target/debian/wdintel-rs_0.1.0-1_amd64.deb /tmp

_echo-generic-deploy-back:
    #!/bin/bash
    set -euxo pipefail
    just builder={{ builder }} _echo-generic-build-rs

    # sync toml config
    ssh {{ server }} 'sudo mkdir -p /etc/echo'
    ssh {{ server }} 'mkdir storage || true'
    set +x
    echo "\n❗ Not deploying config, use config-deploy command\n"
    set -x

    # TODO: determine version from Cargo.toml
    rsync --progress /tmp/wdintel-rs_0.1.0-1_amd64.deb {{ server }}:/tmp
    ssh {{ server }} 'cd /tmp && sudo dpkg -i wdintel-rs_0.1.0-1_amd64.deb'
    set +x
    echo "\n❗ Not deploying signal-cli-native, read echo-im project README.md for that"
    set -x
    echo "Back-end is ready. Now open {{ server }}'s URL"

setup-py:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    . deploy/utils.sh
    ensure_nonempty "server" "{{ server }}"
    ssh {{ server }} 'sudo python3 -m pip install -U -r /usr/share/wdintel-py/requirements.txt'
    ssh {{ server }} 'if ! python3 -c "import spacy; spacy.load(\"ru_core_news_md\")" 2>/dev/null; then sudo python3 -m spacy download ru_core_news_md; else echo "Spacy model already downloaded, skipping"; fi'

ai-mlflow-gc:
    #!/bin/bash
    cd echo-ai
    set -a && . .env && set +a
    [[ -d .venv ]] || uv venv --relocatable
    . .venv/bin/activate
    uv run mlflow gc --backend-store-uri="$MLFLOW_BACKEND_STORE_URI" --artifacts-destination="$MLFLOW_DEFAULT_ARTIFACT_ROOT"

ai-mlflow-server:
    #!/bin/bash
    cd echo-ai
    set -a && . .env && set +a
    [[ -d .venv ]] || uv venv --relocatable
    . .venv/bin/activate
    uv run mlflow server

[arg("databases", long="databases")]
[arg("unsupervised", long="unsupervised")]
ai-mlflow-run databases='wd' unsupervised='false':
    #!/bin/bash
    cd echo-ai
    set -a && . .env && set +a
    [[ -d .venv ]] || uv venv --relocatable
    . .venv/bin/activate
    uv run src/scheduled.py --unsupervised "{{ unsupervised }}" --databases "{{ databases }}"

# setup echo-ai-train environment on server, putting essential scripts that make the container ready to run nightly jobs
[arg('server', long='server')]
setup-echo-ai-train server='echo-ai-train':
    #!/bin/bash
    set -euxo pipefail
    . deploy/utils.sh
    SERVER="{{ server }}"
    ensure_nonempty "server" "$SERVER"

    rsync --delete -rlpt -i -c -h --info=progress2 --filter=':- echo-ai/.gitignore' echo-ai/ "$SERVER:echo-ai/"
    ssh "$SERVER" 'sudo mkdir -p /usr/local/echo-ai-train/'
    echo-install-utils bw-sync "$SERVER" "echo-ai-$SERVER-models-dotenv" "/usr/local/echo-ai-train/.env.train" --no-restart
    ssh -t "$SERVER" echo-ai/deploy.sh

# restore echo-ai-train postgres connectivity to one or more db servers after a major PG upgrade (e.g. PG 18)
# connects to each target through the jump server and re-registers its tailscale IP in pg_hba.conf / listen_addresses

# override the jump server (default echo-ai-train) with --train-host <host>
[arg('train_host', long='train-host')]
setup-echo-ai-train-db train_host='echo-ai-train' *targets:
    #!/bin/bash
    set -euo pipefail
    . deploy/utils.sh
    ensure_nonempty "train_host" "{{ train_host }}"
    ensure_nonempty "targets" "{{ targets }}"
    TRAIN_HOST="{{ train_host }}" echo-ai/pg-access.sh {{ targets }}

# [positional-arguments]
[arg('builder', long='builder')]
[arg('server', long='server')]
ziggy-echo-build-local builder="echo-build-local" server="echo-staging" branch="main":
    #!/bin/bash
    set -euxo pipefail
    BUILDER="{{ builder }}"
    TARGET="{{ server }}"
    BRANCH="{{ branch }}"
    PADD='$HOME/.local/bin:$HOME/.cargo/bin'

    echo "🔄 Pulling latest code on ${BUILDER}..."
    ssh -A "${BUILDER}" 'set -euxo pipefail; cd workspace/echo && git fetch origin '"${BRANCH}"' && git checkout '"${BRANCH}"' && git pull --ff-only origin '"${BRANCH}"' && PATH='"$PADD"':$PATH cargo build --release'

    echo "📦 Copying wdintel-rs binary from ${BUILDER} to ${TARGET}..."
    rsync --info=progress2 "${BUILDER}:workspace/echo/target/release/wdintel-rs" /var/tmp/
    rsync --info=progress2 /var/tmp/wdintel-rs "${TARGET}:/var/tmp/"

    echo "🚀 Updating binary on ${TARGET} and restarting wdintel-rs..."
    ssh -A "${TARGET}" 'set -euxo pipefail; sudo mv /var/tmp/wdintel-rs /usr/bin/wdintel-rs && sudo systemctl restart wdintel-rs'

[arg('branch', long='branch')]
[arg('builder', long='builder')]
build-geo-screenshot builder="" branch="main":
    #!/bin/bash
    set -euxo pipefail

    if [[ "{{ builder }}" == "" ]]; then
        echo "❌ Builder parameter not recognized. Value: {{ builder }}"; exit 1;
    fi

    BUILDER="{{ builder }}"
    BRANCH="{{ branch }}"

    ssh "${BUILDER}" '(cd workspace/map-bot && git fetch origin && git clean -df && git checkout '"${BRANCH}"' && git pull --ff-only origin '"${BRANCH}"')'
    ssh "${BUILDER}" '(cd workspace/map-bot/geo-screenshot && $HOME/.cargo/bin/cargo deb)'
    # TODO: determine version from Cargo.toml
    rsync --progress "${BUILDER}":workspace/map-bot/target/debian/geo-screenshot_0.1.0-1_amd64.deb ~/Downloads/

[arg('branch', long='branch')]
[arg('builder', long='builder')]
[arg('server', long='server')]
deploy-geo-screenshot server="" builder="" branch="main":
    #!/bin/bash
    set -euxo pipefail

    if [[ "{{ server }}" == "" ]]; then
        echo "❌ Server parameter not recognized. Value: {{ server }}"; exit 1;
    fi
    if [[ "{{ builder }}" == "" ]]; then
        echo "❌ Builder parameter not recognized. Value: {{ builder }}"; exit 1;
    fi

    SERVER="{{ server }}"
    BUILDER="{{ builder }}"
    BRANCH="{{ branch }}"

    just build-geo-screenshot --builder "${BUILDER}" --branch "${BRANCH}"

    # TODO: determine version from Cargo.toml
    rsync --progress ~/Downloads/geo-screenshot_0.1.0-1_amd64.deb "${SERVER}":Downloads/
    ssh "${SERVER}" 'sudo apt-get install -y xvfb libxcursor1 libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev libxkbcommon-dev libssl-dev'
    ssh "${SERVER}" 'cd Downloads && sudo dpkg -i geo-screenshot_0.1.0-1_amd64.deb'
    echo "geo-screenshot deploy completed succesfully"

build-docker:
    docker buildx build --platform linux/amd64 .

gen-db-skeleton:
    # just server=echo-zaporizhzha copy-db
    echo "assuming just copy-db is done..."

    @if [[ "{{ server }}" == "echo-kherson" ]]; then \
        echo "server param is ok"; \
    elif [[ "{{ server }}" == "echo-soledar" ]]; then \
        echo "server param is ok"; \
    elif [[ "{{ server }}" == "echo-lyman" ]]; then \
        echo "server param is ok"; \
    elif [[ "{{ server }}" == "echo-kharkiv" ]]; then \
        echo "server param is ok"; \
    elif [[ "{{ server }}" == "hammer" ]]; then \
        echo "server param is ok"; \
    else \
        just _print-servers; exit 1; \
    fi

    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_callsign_changelog;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_callsign;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_unit_changelog;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_unit;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_search;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from signal_attachment;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from signal_group;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_comment;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_bookmark;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_saved_filter;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_important;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_inbox_item;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from signal_message;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from alert;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from bgtask_res;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from bgtask;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from callsign_lexeme;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from comp_freq;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from comp_freq_callsign;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from login where login != 'ziggy'" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_zone_datasource" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_zone where id > 1" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from datasource where id > 1" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from delta_kv" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from network_callsign" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from nominatimres" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from organism where id>1" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from rer_gdoc_callsign" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from restream" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from restream_setup" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from signal_restapi_error" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from url_visit_notification;" -U wd wd
    PASSWORD="{{ pgpwd }}" psql -c "delete from sigint_search;" -U wd wd

    # dump
    (cd ~/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -F c -f wd-{{ dt1 }}.pgrestore wd && ls -lah wd-{{ dt1 }}.pgrestore)
    # restore
    @echo "❗\n❗ run these commands to restore:\n❗"
    @echo scp ~/Downloads/wd-{{ dt1 }}.pgrestore {{ server }}:Downloads/
    @echo ssh {{ server }} $'\'PGPASSWORD="{{ pgpwd }}" pg_restore -U wd -d wd ~/Downloads/wd-{{ dt1 }}.pgrestore\''

# When Discord notification about GDOC Google Keys arrives, launch this command to authorize on all servers. Use rickyrepel@gmail.com as an account.
oneoff-import-gdocs:
    # ssh echo-zaporizhzha '~/workspace/wildducks-intel/wdintel-rs/target/release/wdintel-rs --mode=live oneoff-import-callsigns-gdoc'
    # ssh echo-kherson '/usr/bin/wdintel-rs --mode=live oneoff-import-callsigns-gdoc'
    # ssh echo-donetsk '/usr/bin/wdintel-rs --mode=live oneoff-import-callsigns-gdoc'
    echo "DONE. Now redeploy all the sigint workers"

[arg('server', long='server')]
oneoff-2026-02-13-bgworker-00-pre-deploy server='':
    #!/bin/bash
    set -euo pipefail
    . deploy/utils.sh
    ensure_nonempty "server" "{{ server }}"
    ssh {{ server }} 'for unit in wdintel-rs-bgworker.socket wdintel-py.socket echo-vector.socket; do
      if systemctl list-unit-files --type=socket --no-legend | awk "{print \$1}" | grep -qx "$unit"; then
        sudo systemctl disable --now "$unit" || true
      else
        echo "Unit \"$unit\" not found, skipping."
      fi
    done'
    ssh {{ server }} 'sudo systemctl daemon-reload'
    ssh {{ server }} 'systemctl --no-pager list-unit-files --type=socket | grep -E "wdintel-rs-bgworker\\.socket|wdintel-rs\\.socket|wdintel-py\\.socket|echo-vector\\.socket|echo-signal-bot@\\.socket|echo-whatsapp-bot@\\.socket" || true'

[arg('server', long='server')]
oneoff-2026-02-13-bgworker-01-post-deploy server='':
    #!/bin/bash
    set -euxo pipefail
    . deploy/utils.sh
    ensure_nonempty "server" "{{ server }}"
    ssh {{ server }} 'set -x; sudo systemctl daemon-reload'
    # WDINTEL-PY is managed separately; do not disable it during this rollout.
    ssh {{ server }} '
      set -euo pipefail
      set -x
      echo "Stopping existing wdintel-rs units before enabling new deployment units."
      for unit in wdintel-rs.service wdintel-rs-bgworker.service; do
        if systemctl list-units --all --no-legend --full "$unit" 2>/dev/null | grep -qx "$unit"; then
          if systemctl is-active --quiet "$unit"; then
            echo "Stopping active $unit ..."
            sudo systemctl stop "$unit" || true
            for i in $(seq 1 120); do
              if ! systemctl is-active --quiet "$unit"; then
                echo "$unit is stopped."
                break
              fi
              if [ "$i" -eq 120 ]; then
                echo "ERROR: $unit did not stop within 120 seconds." >&2
                exit 1
              fi
              sleep 1
            done
          else
            echo "$unit already stopped."
          fi
        else
          echo "$unit not installed on this host."
        fi
      done
    '
    ssh {{ server }} 'set -x
      echo "Checking port 8081 listeners before enabling units:"
      if sudo ss -ltnp | grep -q "LISTEN .*:8081"; then
        echo "Active LISTEN on :8081:"
        sudo ss -ltnp | grep "LISTEN .*:8081" || true
        if ! sudo ss -ltnp | grep "LISTEN .*:8081" | grep -q systemd; then
          echo "ERROR: non-systemd listener on :8081 found. Release it before rerun."
          if command -v lsof >/dev/null 2>&1; then
            sudo lsof -iTCP:8081 -sTCP:LISTEN -n -P || true
          fi
          exit 1
        fi
      fi
      if command -v lsof >/dev/null 2>&1; then
        sudo lsof -iTCP:8081 -sTCP:LISTEN -n -P || true
      fi
    '
    ssh {{ server }} '
      if sudo ss -ltnp | grep -q "LISTEN .*:8081"; then
        echo "Port 8081 is already bound; checking known conflicting units."
        sudo ss -ltnp | grep "LISTEN .*:8081" || true

        echo "Stopping conflict-prone socket units on this host."
        for unit in wdintel-rs-bgworker.socket wdintel-py.socket echo-vector.socket; do
          if systemctl list-unit-files --type=socket --no-legend | awk "{print \$1}" | grep -qx "$unit"; then
            sudo systemctl disable --now "$unit" || true
          fi
        done

        for unit in $(sudo systemctl list-units --all --no-legend --full "echo-signal-bot@*.service" "echo-signal-bot@*.socket" "echo-whatsapp-bot@*.service" "echo-whatsapp-bot@*.socket" | cut -d " " -f1); do
          echo "Stopping conflicting unit: $unit"
          sudo systemctl disable --now "$unit" || true
        done

        if sudo ss -ltnp | grep -q "LISTEN .*:8081"; then
          if ! sudo ss -ltnp | grep "LISTEN .*:8081" | grep -q "systemd"; then
            echo "ERROR: 8081 is still in use by non-systemd process after cleanup."
            sudo ss -ltnp | grep "LISTEN .*:8081" || true
            exit 1
          fi
        fi
      fi
    '
    ssh {{ server }} 'set -x; sudo systemctl enable --now wdintel-rs.socket'
    ssh {{ server }} 'set -x; sudo systemctl enable --now wdintel-rs-bgworker'
    ssh {{ server }} 'set -x; sudo systemctl disable --now wdintel-rs.service'
    ssh {{ server }} 'set -x; systemctl --no-pager status wdintel-rs.socket wdintel-rs-bgworker.service --no-pager'

# WARNING! ECHO-IM and ECHO-GPU-CLIENT migrations are not applied here. Use migrate-all-up for the production-order migration sequence.
#

# If you want to migrate test database, run `cargo run -p wdintel-rs -- --mode=test migrate`
migrate-all-up mode="debug":
    cargo run -p wdintel-rs -- --mode={{ mode }} migrate

migrate-up:
    cd echo-migration && DATABASE_URL=postgresql://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd cargo run -- up
    echo '⚠️ WARNING! ECHO-IM and ECHO-GPU-CLIENT migrations are not applied here. Run `just migrate-all-up` for all schemas.'

migrate-down:
    cd echo-migration && DATABASE_URL=postgresql://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd cargo run -- down
    echo '⚠️ WARNING! This rolls back only the Echo application schema, not ECHO-IM or ECHO-GPU-CLIENT.'

[arg('dry_run', long='dry-run', value='true')]
[arg('mode', long='mode')]
[arg('since_ts', long='since-ts')]
backfill-audio-transcriber since_ts dry_run="false" mode="debug":
    #!/bin/bash
    set -euo pipefail
    if [[ ! "{{ since_ts }}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || \
        ! parsed_since_ts="$(date -u -d "{{ since_ts }}" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null)" || \
        [[ "$parsed_since_ts" != "{{ since_ts }}" ]]; then
        echo 'Use --since-ts=yyyy-MM-ddThh:mm:ss, for example --since-ts=2026-07-01T00:00:00' >&2
        exit 2
    fi
    args=(--since-ts "{{ since_ts }}")
    if [[ "{{ dry_run }}" == "true" ]]; then args+=(--dry-run); fi
    cargo run -p wdintel-rs -- --mode={{ mode }} oneoff-backfill-audio-transcriber "${args[@]}"

[arg('mode', long='mode')]
[arg('reason', long='reason')]
[arg('requester', long='requester')]
[arg('source_id', long='source-id')]
requeue-audio-transcriber source_id requester reason mode="debug":
    cargo run -p wdintel-rs -- --mode={{ mode }} oneoff-requeue-audio-transcriber --source-id "{{ source_id }}" --requester "{{ requester }}" --reason "{{ reason }}"

[arg('mode', long='mode')]
[arg('reason', long='reason')]
[arg('requester', long='requester')]
[arg('source_id', long='source-id')]
retranscribe-audio-transcriber source_id requester reason mode="debug":
    cargo run -p wdintel-rs -- --mode={{ mode }} oneoff-retranscribe-audio-transcriber --source-id "{{ source_id }}" --requester "{{ requester }}" --reason "{{ reason }}"

# puts deploy/vector/vector-echo.yaml into /etc/vector/vector.yaml of a corresponding server
deploy-vector-conf:
    # TODO: ensure vector is installed via `bash -c "$(curl -L https://setup.vector.dev)"` and `sudo apt-get install vector`
    # TODO: ensure nginx has access_log configured due to deploy/vector/README.md instructions
    scp deploy/vector/vector-echo.yaml {{ server }}:
    ssh {{ server }} 'sudo mkdir -p /etc/vector && sudo mv vector-echo.yaml /etc/vector/vector.yaml'
    ssh {{ server }} 'sudo systemctl daemon-reload'
    ssh {{ server }} 'sudo systemctl enable vector'
    ssh {{ server }} 'sudo systemctl restart vector'

docs:
    cd docs && zola build

dev-docs:
    cd docs && zola serve

docs-deb: docs
    cd docs/echo-docs && cargo deb && cp target/debian/echo-docs_0.1.0-1_amd64.deb ~/Downloads/echo-docs_0.1.0-1_amd64.deb

builder-build-docs: prepare-workspace
    #!/bin/bash
    if [[ "{{ builder }}" == "echo-gpu" ]]; then
      ssh {{ builder }} '(cd ~/workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
      ssh {{ builder }} '(cd ~/workspace/echo && just prepare-workspace)'
      ssh {{ builder }} '(cd ~/workspace/echo/docs && zola build)'
      ssh {{ builder }} '(cd ~/workspace/echo/docs/echo-docs && PATH=$HOME/.local/bin:$PATH /home/ubuntu/.cargo/bin/cargo deb)'
      rsync {{ builder }}:~/workspace/echo/docs/echo-docs/target/debian/echo-docs_0.1.0-1_amd64.deb ~/Downloads/
    else
      echo "❌ Builder parameter not recognized. Value: {{ builder }}"; exit 1;
    fi

[arg('server', long='server')]
deploy-docs _server_pos="" server:
    #!/bin/bash
    set -euo pipefail
    if [[ "${DEBUG:-0}" == "1" || "${TRACE:-0}" == "1" ]]; then
      set -x
    fi
    if [[ "{{ _server_pos }}" != "" && "{{ server }}" != "" ]]; then
      echo "pass either positional server or --server, not both." >&2
      exit 1
    fi

    if [[ "{{ _server_pos }}" != "" ]]; then
      SERVER="{{ _server_pos }}"
    elif [[ "{{ server }}" != "" ]]; then
      SERVER="{{ server }}"
    else
      just _print-servers; exit 1;
    fi

    VERSION=$(tq -r -f Cargo.toml workspace.package.version)

    if [[ -z "$VERSION" ]]; then
      echo "Failed to detect version from Cargo.toml" >&2
      exit 1
    fi

    STARTED_KEY="echo-ci:deploy:echo:started:$VERSION"
    FINISHED_KEY="echo-ci:deploy:echo:finished:$VERSION"

    BUILDER="${BUILDER:-echo-build-main}"
    CI_SSH_TARGET="$BUILDER"
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$CI_SSH_TARGET" true 2>/dev/null; then
      echo "Cannot SSH to $CI_SSH_TARGET; required to check Redis keys" >&2
      exit 1
    fi

    wait_for_ci_key() {
      local key="$1"
      local max_label="$2"
      local attempts="$3"
      local failure_message="$4"
      local ok=0

      echo "Waiting up to $max_label for CI key: $key ..."
      local trace_was_on=0
      case $- in *x*) trace_was_on=1;; esac
      [[ $trace_was_on -eq 1 ]] && set +x
      for i in $(seq 1 "$attempts"); do
        exists=$(ssh "$CI_SSH_TARGET" redis-cli EXISTS "$key")
        if [[ "$exists" == "1" ]]; then ok=1; break; fi
        sleep 5
        echo -n "."
      done
      [[ $trace_was_on -eq 1 ]] && set -x
      echo
      if [[ $ok -ne 1 ]]; then
        echo "$failure_message" >&2
        exit 1
      fi
    }

    printf "\n📚📚📚 deploying docs %s 📚📚📚\n\n" "$SERVER"

    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"deploying docs $SERVER (version $VERSION); waiting for CI from $(hostname)\"}" \
      '{{ discord_webhook_infra }}' || true

    echo "CI: https://github.com/echoua/echo/actions"

    wait_for_ci_key "$STARTED_KEY" "15m" 180 \
      "CI did not start publishing for version $VERSION within 15m (key $STARTED_KEY missing)"
    echo "CI started detected."
    wait_for_ci_key "$FINISHED_KEY" "10m" 120 \
      "CI did not finish publishing for version $VERSION within 10m (key $FINISHED_KEY missing)"

    echo "CI finished detected. Proceeding with remote apt install for echo-docs."
    ssh "$SERVER" 'set -euo pipefail
      run_logged() {
        local timeout_secs="$1"
        local command_text="$2"
        shift 2

        echo "+ $command_text"
        local status=0
        if timeout --foreground "${timeout_secs}s" "$@"; then
          status=0
        else
          status="$?"
        fi
        if [ "$status" -eq 0 ]; then
          return 0
        fi

        if [ "$status" -eq 124 ]; then
          echo "$command_text timed out after ${timeout_secs}s." >&2
        else
          echo "$command_text failed with exit code $status." >&2
        fi
        return "$status"
      }

      run_logged 600 "sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update" \
        sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update
      run_logged 1200 "sudo env DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Lock::Timeout=120 -y -qq install echo-docs" \
        sudo env DEBIAN_FRONTEND=noninteractive \
          apt-get -o Dpkg::Lock::Timeout=120 -y -qq install echo-docs

      installed=$(dpkg-query -W -f=\${Version} echo-docs)
      echo "✅✅✅ docs deploy OK on $HOSTNAME: echo-docs $installed ✅✅✅"
    '

    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"✅ Deployed docs $SERVER (version $VERSION) via apt-get\"}" \
      '{{ discord_webhook_infra }}' || true

fmt:
    just --fmt --unstable
    (cd echo-migration && cargo fmt)
    (cd wdintel-rs && cargo fmt)
    (cd wdintel-web && npm run format:all)
    (cd wdintel-rs && cargo clippy --all-targets --all-features -- -D warnings)

# setup-kibana-local:
#     #!/bin/bash
#     sudo mkdir -p /etc/kibana
#     sudo cp deploy/kibana/env.example /etc/kibana/.env
#     sudo cp deploy/kibana/compose.yaml /etc/kibana/compose.yaml
#     (cd /etc/kibana && sudo docker compose up -d)
# setup-kibana-hammer:
#     #!/bin/bash
#     ssh hammer 'sudo mkdir -p /etc/kibana'
#     scp deploy/kibana/env-hammer hammer:~ && ssh hammer 'sudo mv ~/env-hammer /etc/kibana/.env'
#     scp deploy/kibana/compose.yaml hammer:~ && ssh hammer 'sudo mv ~/compose.yaml /etc/kibana/compose.yaml'
#     ssh hammer 'cd /etc/kibana && sudo docker compose up -d'
# setup-vector-local:
#     #!/bin/bash
#     sudo rm -rf /etc/vector
#     sudo mkdir -p /etc/vector
#     sudo cp deploy/vector/vector-echo.yaml /etc/vector/vector.yaml
#     sudo cp deploy/vector/env.example /etc/default/vector
#     sudo sh -c 'echo "PGPASSWORD={{ pgpwd }}" >> /etc/default/vector'
#     sudo systemctl enable vector && sudo systemctl daemon-reload
#     sudo systemctl restart vector
# setup-vector-local-hammer:
#     #!/bin/bash
#     sudo rm -rf /etc/vector
#     sudo mkdir -p /etc/vector
#     sudo cp deploy/vector/vector-echo.yaml /etc/vector/vector.yaml
#     sudo cp deploy/vector/env-hammer /etc/default/vector
#     sudo sh -c 'echo "PGPASSWORD={{ pgpwd }}" >> /etc/default/vector'
#     sudo systemctl enable vector && sudo systemctl daemon-reload
#     sudo systemctl restart vector
# install-vector:
#     ssh {{ server }} 'bash -c "$(curl -L https://setup.vector.dev)" && sudo apt-get install vector'
#     ssh {{ server }} "PGPASSWORD={{ pgpwd }} sudo -u postgres psql -c \"CREATE USER vector WITH PASSWORD '{{ pgpwd }}';\""
#     ssh {{ server }} 'PGPASSWORD={{ pgpwd }} sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE wd TO vector;"'
# setup-vector:
#     ssh {{ server }} 'sudo mkdir -p /etc/vector'
#     scp deploy/vector/vector-echo.yaml  {{ server }}:~/vector.yaml
#     ssh {{ server }} 'sudo mv ~/vector.yaml /etc/vector/vector.yaml'
#     scp deploy/vector/env-hammer  {{ server }}:~/vector.env
#     ssh {{ server }} 'sudo mv ~/vector.env /etc/default/vector'
#     ssh {{ server }} 'echo "TARGET_MACHINE={{ server }}" >> /etc/default/vector'
#     ssh {{ server }} 'echo "PGPASSWORD={{ pgpwd }}" >> /etc/default/vector'
#     ssh {{ server }} 'sudo systemctl enable vector'
#     ssh {{ server }} 'sudo systemctl daemon-reload'
#     ssh {{ server }} 'sudo systemctl restart vector'

update-certs-vault:
    ssh hammer " \
    sudo -S tailscale cert hammer.golden-banded.ts.net && \
    sudo cp hammer.golden-banded.ts.net.crt /etc/kibana/kibana.echo.crt && \
    sudo cp hammer.golden-banded.ts.net.key /etc/kibana/kibana.echo.key && \
    sudo mv hammer.golden-banded.ts.net.crt ~/.ssh/ && \
    sudo mv hammer.golden-banded.ts.net.key ~/.ssh/ && \
    sudo systemctl restart nginx"

[arg('server', long='server')]
config-deploy server:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    . deploy/utils.sh
    ensure_nonempty "server" "{{ server }}"
    # Notify Discord at the start of deployment including local hostname
    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"deploying config for {{ server }} from $(hostname)\"}" \
      '{{ discord_webhook_infra }}' || true
    # bw_sync "{{ server }}" "echo-config-{{ server }}" "/etc/echo/config.toml" "wdintel-rs"
    echo-install-utils bw-sync "{{ server }}" "echo-config-{{ server }}" "/etc/echo/config.toml" "wdintel-rs"

[arg('analytics_server', long='analytics-server')]
[arg('source_server', long='source-server')]
analytics-secrets-deploy source_server analytics_server:
    #!/bin/bash
    set -euo pipefail
    if [[ -z "{{ source_server }}" || -z "{{ analytics_server }}" ]]; then
        echo "both --source-server and --analytics-server are required" >&2
        exit 1
    fi
    echo-install-utils bw-sync \
      "{{ analytics_server }}" \
      "echo-clickhouse-{{ source_server }}" \
      "/etc/echo-analytics/clickhouse.env" \
      --no-restart
    echo-install-utils bw-sync \
      "{{ analytics_server }}" \
      "echo-peerdb-{{ source_server }}" \
      "/etc/echo-analytics/peerdb.env" \
      --no-restart
    ssh "{{ analytics_server }}" \
      'cd /opt/echo-analytics/deploy && bin/02-configure-analytics.sh && bin/03-install-services.sh'

analytics-reconcile-tables:
    deploy/clickhouse/bin/source-reconcile-tables.sh --yes

analytics-reconcile-derived-schema:
    bash deploy/clickhouse/bin/source-reconcile-derived-schema.sh

setup-analytics-reconcile-tables:
    deploy/clickhouse/bin/source-sync-exclusions.sh --yes

setup-vault:
    just is_dev='false' app="echo" server={{ server }} vault_server=srv-vault vault_addr='https://srv-vault.golden-banded.ts.net:7300' _setup-vault

_setup-vault:
    #!/bin/bash
    set -euxo pipefail
    IS_LOCAL={{ is_dev }} # TODO replace with check if vault server is localhost
    . deploy/utils.sh

    PROJECT='{{ app }}'
    VAULT_ADDR={{ vault_addr }}
    VAULT_ROOT="{{ app }}"
    # is applicable for DEV environment only
    VAULT_CACERT_PATH={{ vault_cert_path }}

    vault_ensure_enabled {{ vault_server }} $VAULT_ADDR $VAULT_ROOT $VAULT_CACERT_PATH $IS_LOCAL

    POLICY=$(generate_policy $VAULT_ROOT {{ server }})
    POLICY_KEY={{ app }}-{{ server }}-policy
    ssh {{ vault_server }} "echo '$POLICY' > /tmp/policy.hcl"
    ssh -t {{ vault_server }} "
      export VAULT_ADDR=$VAULT_ADDR
      if [[ $IS_LOCAL == 'true' ]]; then
        export VAULT_CACERT=$VAULT_CACERT_PATH
      fi
      vault policy write $POLICY_KEY /tmp/policy.hcl
    "
    ssh {{ vault_server }} 'rm /tmp/policy.hcl'

    KEY={{ app }}-vault-{{ server }}
    bw_get_note $KEY > /tmp/bw-note.txt

    VAULT_KV_LOGIN=$(tq --file=/tmp/bw-note.txt '.login')
    VAULT_KV_PASSWORD=$(tq --file=/tmp/bw-note.txt '.password')
    ssh {{ vault_server }} "
      export VAULT_ADDR=$VAULT_ADDR
      if [[ $IS_LOCAL == 'true' ]]; then
        export VAULT_CACERT=$VAULT_CACERT_PATH
      fi
      vault write auth/userpass/users/$VAULT_KV_LOGIN password=$VAULT_KV_PASSWORD policies=$POLICY_KEY
    "
    scp /tmp/bw-note.txt {{ vault_server }}:/tmp/bw-note.txt
    ssh -t {{ vault_server }} "sudo mkdir -p /etc/{{ app }}"
    ssh -t {{ vault_server }} "sudo mv /tmp/bw-note.txt /etc/{{ app }}/vault.toml"

    rm /tmp/bw-note.txt

    bw_get_note {{ app }}-vault-config-{{ server }} > /tmp/bw-config-note.txt
    scp /tmp/bw-config-note.txt {{ vault_server }}:/tmp/bw-config-note.txt

    ssh {{ vault_server }} "
      export VAULT_ADDR=$VAULT_ADDR
      if [[ $IS_LOCAL == 'true' ]]; then
        export VAULT_CACERT=$VAULT_CACERT_PATH
      fi
      vault kv put $VAULT_ROOT/{{ server }}/config $(cat /tmp/bw-config-note.txt | tr '\n' ' ') && rm /tmp/bw-config-note.txt"

# FOR GREPTIME SEE echo-sergeant/greptime/README

setup-server:
    ssh {{ server }} 'sudo wdintel-rs --mode=live oneoff-install'

setup-server-interactive:
    ssh {{ server }} 'sudo wdintel-rs --    mode=live oneoff-install --interactive'

deploy-rustdocs:
    #!/bin/bash
    set -euxo pipefail

    NGINX_CONF=./deploy/nginx/echo-docs
    OUT_ZIP=./deploy/echo-docs.zip
    ZIP_FILENAME=$(basename "$OUT_ZIP")

    (cd "wdintel-rs" && cargo doc)
    rm -f "$OUT_ZIP"
    zip -r "$OUT_ZIP" "$NGINX_CONF" "wdintel-rs/target/doc"
    ssh {{ server }} -- 'rm -rf ./echo-docs && sudo rm -rf /usr/share/echo-docs && sudo rm -rf /etc/nginx/sites-enabled/echo-docs'
    ssh {{ server }} -- 'mkdir -p echo-docs'
    rsync -aqz "$OUT_ZIP" "{{ server }}:~/echo-docs/"
    ssh {{ server }} -- "cd echo-docs && unzip -q ./${ZIP_FILENAME} && sudo cp -r ./${NGINX_CONF} /etc/nginx/sites-enabled/ && sudo cp -R ./wdintel-rs/target/doc /usr/share/echo-docs"
    ssh {{ server }} -- 'sudo chown -R root:root /usr/share/echo-docs && sudo systemctl restart nginx'

init-new-db:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    scp ./deploy/wd-init.pgrestore {{ server }}:/var/tmp/
    ssh -t {{ server }} "sudo mv /var/tmp/wd-init.pgrestore /tmp/wd_init.pgrestore"
    ssh -t {{ server }} "sudo -u postgres psql -c 'drop database {{ pgdb }} with (FORCE)' | echo 'ok'"
    ssh -t {{ server }} "sudo -u postgres psql -c 'create database {{ pgdb }}'"
    ssh -t {{ server }} "sudo -u postgres pg_restore -d {{ pgdb }} /tmp/wd_init.pgrestore"

oneoff-reprocess-units-search-index:
    ssh echo-volyn2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'
    ssh echo-zaporizhzha2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'
    ssh echo-kherson2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'
    ssh echo-donetsk2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'

# build and copy deb and binary for echo-install
builder-build-echo-install: prepare-workspace
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ builder }}" == "" ]] ; then
        echo "❌ builder parameter not recognized. value: {{ builder }}"; exit 1;
    fi
    ssh {{ builder }} '(cd ~/workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh {{ builder }} '(cd ~/workspace/echo && just prepare-workspace)'
    ssh {{ builder }} '(cd ~/workspace/echo && /home/ubuntu/.cargo/bin/cargo deb -p echo-install)'
    rsync --progress {{ builder }}:~/workspace/echo/target/debian/echo-install_0.1.0-1_amd64.deb /tmp/
    rsync --progress {{ builder }}:~/workspace/echo/target/release/echo-install /tmp/

# Build a directory under target/build with echo-install binary and deb plus wdintel-rs deb,

# then copy it to a given server under /tmp/echo-install-package
deploy-echo-install-package:
    #!/bin/bash
    set -euxo pipefail

    if [[ "{{ builder }}" == "" ]] ; then
        echo "❌ builder parameter not recognized. value: {{ builder }}"; exit 1;
    fi
    if [[ "{{ server }}" == "" ]] ; then
        just _print-servers; exit 1;
    fi

    TGT_DIR=target/echo-install-package
    TGT_DIR_SERVER=/tmp/echo-install-package
    (rm -rf $TGT_DIR || true) && mkdir -p $TGT_DIR

    just builder={{ builder }} builder-build-echo-install
    cp /tmp/echo-install_0.1.0-1_amd64.deb $TGT_DIR/
    cp /tmp/echo-install $TGT_DIR/

    just builder={{ builder }} _echo-generic-build-rs
    cp /tmp/wdintel-rs_0.1.0-1_amd64.deb $TGT_DIR/

    ssh {{ server }} "rm -rf $TGT_DIR_SERVER || true && mkdir -p $TGT_DIR_SERVER"
    rsync -r $TGT_DIR/ {{ server }}:$TGT_DIR_SERVER/

deploy-stg: prepare-workspace
    #!/bin/bash
    set -euxo pipefail
    ssh echo-build-main "cd ~/workspace/krab/echo-feature/echo && \
        git fetch origin && \
        git checkout main && \
        git checkout {{ branch }} && \
        git pull && \
        cd wdintel-web && \
        git pull && \
        . ~/.nvm/nvm.sh && \
        npx npm ci && \
        npm run build && \
        cd .. && \
        just prepare-workspace && \
        touch wdintel-rs/build.rs && \
        \$HOME/.cargo/bin/cargo deb -p wdintel-rs --fast"
    scp echo-build-main:~/workspace/krab/echo-feature/echo/target/debian/wdintel-rs*.deb "echo-staging":/var/tmp
    ssh echo-build-main 'rm ~/workspace/krab/echo-feature/echo/target/debian/wdintel-rs*.deb'
    ssh "echo-staging" 'cd /var/tmp/ && sudo apt install -y --reinstall --allow-downgrades ./wdintel-rs*.deb'

[arg('server', long='server')]
transcriber-smoke server:
    #!/bin/bash
    set -euo pipefail
    ssh "{{ server }}" 'sudo -u postgres psql -d wd -v ON_ERROR_STOP=1 -Atc "select uuid_generate_v7() is not null;" | grep -qx t'
    ssh "{{ server }}" 'sudo -u postgres psql -d wd -v ON_ERROR_STOP=1 -Atc "select count(*) = 2 from seaql_echo_gpu_migrations where version in ('"'"'m20260721_000001_create_gpu_config'"'"', '"'"'m20260721_000002_create_transcription_queue'"'"');" | grep -qx t'
    ssh "{{ server }}" 'sudo -u postgres psql -d wd -v ON_ERROR_STOP=1 -AtF "|" -c "select to_regclass('"'"'gpu_config'"'"'), to_regclass('"'"'echo_gpu_transcription_queue'"'"');" | grep -qx "gpu_config|echo_gpu_transcription_queue"'
    ssh "{{ server }}" 'sudo -u postgres psql -d wd -v ON_ERROR_STOP=1 -Atc "select coalesce((select enable_audio_transcription from system_settings where not deleted order by updated_at desc limit 1), false);" | grep -Eq "^[tf]$"'
    ssh "{{ server }}" 'sudo -u postgres psql -d wd -v ON_ERROR_STOP=1 -c "select state, count(*) from echo_gpu_transcription_queue group by state order by state;"'
    ssh "{{ server }}" 'sudo -u postgres psql -d wd -v ON_ERROR_STOP=1 -c "select greatest(0, extract(epoch from ((now() at time zone '"'"'utc'"'"') - min(coalesce(next_retry_at, created_at)))))::bigint oldest_due_age_seconds from echo_gpu_transcription_queue where state in ('"'"'queued'"'"', '"'"'retrying'"'"');"'
    ssh "{{ server }}" 'systemctl is-active wdintel-rs.socket wdintel-rs-bgworker.service'
    ssh "{{ server }}" 'code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8081/api/admin/transcriber/status); echo "transcriber_status_http=$code"; test "$code" = 401'
    ssh "{{ server }}" 'journalctl -u wdintel-rs-bgworker.service --since "10 minutes ago" --no-pager | grep -E "audio transcription (worker started|status).*worker_id="'

[arg('branch', long='branch')]
deploy-transcriber-stg branch:
    just branch={{ branch }} deploy-stg
    ssh "echo-staging" 'sudo /usr/bin/wdintel-rs --mode=live migrate'
    just transcriber-smoke --server=echo-staging

export-datasource-to-target:
    ssh {{ server }} -t 'wdintel-rs --mode=live oneoff-export-data-source --destination-path /tmp/ds_export_{{ dt1 }}.json --datasource-id {{ datasource_id }} --since-epoch-ms {{ since_ts }} --till-epoch-ms {{ till_ts }} '
    ssh -t {{ server }} 'mv /tmp/ds_export_{{ dt1 }}.json /tmp/ds_import_{{ dt1 }}.json && gzip -c /tmp/ds_import_{{ dt1 }}.json > /tmp/ds_import_{{ dt1 }}.json.gz'
    scp {{ server }}:/tmp/ds_import_{{ dt1 }}.json.gz {{ target }}:/tmp/ds_import_{{ dt1 }}.json.gz
    ssh -t {{ target }} '(cd /tmp && gunzip ds_import_{{ dt1 }}.json.gz)'
    ssh {{ target }} -t 'sudo mkdir -p /var/log/echo_ds_import/ && sudo touch /var/log/echo_ds_import/{{ server }}-{{ dt1 }}.log && sudo chmod 777 /var/log/echo_ds_import/{{ server }}-{{ dt1 }}.log'
    ssh {{ target }} 'sudo nohup {{ echo_bin }} --mode=live oneoff-import-data-source --source-path /tmp/ds_import_{{ dt1 }}.json >> /var/log/echo_ds_import/{{ server }}-{{ dt1 }}.log 2>&1 &'

# import from `server` to `target` etalon data (callsigns, networks, etc)
import-etalon-to-target:
    #!/bin/bash
    set -euxo pipefail

    if [[ "{{ origin }}" == "" ]] ; then
        echo "`origin` is not set; see prod db for sigint_origin.name"
        exit 1
    fi
    ssh -t {{ server }} 'wdintel-rs --mode=live oneoff-export-etalon-data --destination-path /tmp/et_export_{{ dt1 }}.json'
    scp {{ server }}:/tmp/et_export_{{ dt1 }}.json {{ target }}:/tmp/et_import_{{ dt1 }}.json
    ssh -t {{ target }} '{{ echo_bin }} --mode=live oneoff-import-etalon-data --path /tmp/et_import_{{ dt1 }}.json --origin {{ origin }}'

# import from `server` to `target` unit data (units, callsigns, signals)
import-unit-to-target:
    #!/bin/bash
    set -euxo pipefail
    . deploy/utils.sh

    if [[ "{{ origin }}" == "" ]] ; then
        echo "`origin` is not set; see prod db for sigint_origin.name"
        exit 1
    fi
    ssh -t {{ server }} 'wdintel-rs --mode=live export-unit --name "{{ unit }}" --dest-path /tmp/unit_export_{{ dt1 }}.json'
    ask_yes_no
    scp {{ server }}:/tmp/unit_export_{{ dt1 }}.json {{ target }}:/tmp/unit_import_{{ dt1 }}.json
    ssh -t {{ target }} '{{ echo_bin }} --mode=live import-unit --src-path /tmp/unit_import_{{ dt1 }}.json --origin {{ origin }}'

# [positional-arguments]
[arg('builder', long='builder')]
[arg('server', long='server')]
setup-iggy server="echo-staging" builder="echo-build-main":
    just deploy-config-iggy --server {{ server }}
    just builder={{ builder }} _builder-build-iggy
    ssh {{ builder }} "[ -f /home/ubuntu/workspace/echo/target/debian/echo-iggy*.deb ]"
    scp {{ builder }}:/home/ubuntu/workspace/echo/target/debian/echo-iggy*.deb "{{ server }}:/var/tmp/echo-iggy-server.deb"
    ssh {{ server }} "sudo mkdir -p /etc/iggy/data && sudo apt-get install -y python3-toml /var/tmp/echo-iggy-server.deb && rm /var/tmp/echo-iggy-server.deb"
    just _ensure-iggy-users --server {{ server }}
    @echo "==> Pipeline finished successfully!"

[arg('server', long='server')]
_ensure-iggy-users server:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh -T "{{ server }}" sudo /usr/bin/python3 - /etc/iggy/config.toml < deploy/ensure_iggy_users.py

# [positional-arguments]
_builder-build-iggy:
    @echo "==> Checking workspace existence on build server..."
    ssh {{ builder }} "[ -d {{ workspace_iggy }} ]" || (echo "ERROR: Remote folder {{ workspace_iggy }} does not exist on {{ builder }}" && exit 1)
    @echo "==> Building optimized native binary on build server..."
    ssh {{ builder }} "cd {{ workspace_iggy }} && RUSTFLAGS='-C target-cpu=native' /home/ubuntu/.cargo/bin/cargo build --release --bin iggy-server"
    ssh {{ builder }} "cp {{ workspace_iggy }}/target/release/iggy-server /home/ubuntu/workspace/echo/{{ local_assets_iggy }}/"
    ssh {{ builder }} "cd /home/ubuntu/workspace/echo/{{ local_assets_iggy }} && /home/ubuntu/.cargo/bin/cargo deb --no-build"

# [positional-arguments]
[arg('builder', long='builder')]
[arg('rev', long='rev')]
switch-version-iggy rev=iggy_default_rev builder="echo-build-main":
    #!/usr/bin/env bash
    set -euo pipefail
    ssh "{{ builder }}" bash -s -- "{{ rev }}" "{{ iggy_fork_remote }}" <<'REMOTE'
    set -euo pipefail
    rev="$1"
    fork_remote="$2"
    cd workspace/iggy
    git fetch --tags origin "+refs/heads/*:refs/remotes/origin/*"
    git fetch --tags "$fork_remote" "+refs/heads/*:refs/remotes/k-bx/*"
    if git rev-parse --verify --quiet "$rev^{commit}" >/dev/null; then
        git checkout --detach "$rev"
    elif git rev-parse --verify --quiet "origin/$rev^{commit}" >/dev/null; then
        git checkout --detach "origin/$rev"
    elif git rev-parse --verify --quiet "k-bx/$rev^{commit}" >/dev/null; then
        git checkout --detach "k-bx/$rev"
    elif git rev-parse --verify --quiet "tags/iggy-$rev^{commit}" >/dev/null; then
        git checkout --detach "tags/iggy-$rev"
    else
        git checkout --detach "$rev"
    fi
    REMOTE
    echo
    echo "🚀 run setup-iggy now"
    echo

# Update UFW firewall rules on a remote server based on local config.toml

# Usage: just update-firewall user@remote-server-ip [config]
update-firewall remote_host config="config.toml":
    #!/usr/bin/env bash
    set -euo pipefail

    CONFIG="{{ config }}"

    if [ ! -f "$CONFIG" ]; then
        echo "Error: $CONFIG not found locally."
        exit 1
    fi

    # 1. Parse the local config.toml details first
    get_port() {
        local section=$1
        if awk -v sec="\\[$section\\]" 'BEGIN{p=0} $0~sec{p=1} p && /enabled = false/{p=0; exit} p && /address =/{print $0; exit}' "$CONFIG" | grep -q "true" || \
           awk -v sec="\\[$section\\]" 'BEGIN{p=0} $0~sec{p=1} p && /enabled = true/{print "enabled"; exit}' "$CONFIG" | grep -q "enabled"; then
            awk -v sec="\\[$section\\]" 'BEGIN{p=0} $0~sec{p=1} p && /address =/{gsub(/.*:/,""); gsub(/"/,""); print $1; exit}' "$CONFIG"
        fi
    }

    WHITELIST_IPS=$(awk '/whitelist =/{gsub(/[^0-9.,]/,""); print}' "$CONFIG" | tr ',' ' ')
    PORTS=""
    TCP_PORT=$(get_port "tcp")
    HTTP_PORT=$(get_port "http")

    [ -n "$TCP_PORT" ] && PORTS="$PORTS $TCP_PORT"
    [ -n "$HTTP_PORT" ] && PORTS="$PORTS $HTTP_PORT"

    if [ -z "$PORTS" ]; then
        echo "No enabled TCP or HTTP ports found in $CONFIG. Nothing to do."
        exit 0
    fi

    echo "Connecting to {{ remote_host }} to update firewall for ports: $PORTS..."

    # 2. Stream the execution script to the remote server over SSH
    # We pass the local variables downstream into the SSH environment using 'EOF'
    ssh -T "{{ remote_host }}" bash -s << EOF
        set -euo pipefail

        PORTS="$PORTS"
        WHITELIST_IPS="$WHITELIST_IPS"

        # --- IDEMPOTENCY: Reset existing rules for these specific ports ---
        for port in \$PORTS; do
            echo "Remote: Resetting existing UFW rules for port \$port..."
            while sudo ufw status numbered | grep -E "\b\$port\b" >/dev/null; do
                NUM=\$(sudo ufw status numbered | grep -E "\b\$port\b" | head -n1 | awk -F'[][]' '{print \$2}')
                sudo ufw --force delete "\$NUM" > /dev/null
            done
        done

        # --- APPLY NEW RULES ---
        for port in \$PORTS; do
            echo "Remote: Configuring rules for port \$port..."

            # 1. Localhost
            sudo ufw allow from 127.0.0.1 to any port "\$port" proto tcp > /dev/null
            sudo ufw allow from ::1 to any port "\$port" proto tcp > /dev/null

            # 2. Whitelisted IPs passed downstream
            for ip in \$WHITELIST_IPS; do
                if [ -n "\$ip" ]; then
                    echo "  Allowing IP: \$ip"
                    sudo ufw allow from "\$ip" to any port "\$port" proto tcp > /dev/null
                fi
            done

            # 3. Deny all fallback
            sudo ufw deny "\$port"/tcp > /dev/null
        done

        echo "✓ Remote firewall updated successfully."
        echo "Current UFW Status:"
        sudo ufw status verbose
    EOF

[arg("server", long="server")]
deploy-config-iggy server:
    #!/usr/bin/env bash
    set -euo pipefail

    . deploy/utils.sh

    SERVER="{{ server }}"
    ensure_nonempty "server" "$SERVER"

    CONFIG="$(mktemp)"
    trap "rm -f \"$CONFIG\"" EXIT
    chmod 600 "$CONFIG"

    bw sync 1>&2
    bw get notes "iggy-config-$SERVER" > "$CONFIG"
    scp "$CONFIG" "$SERVER:/var/tmp/iggy-config.toml"
    ssh "$SERVER" "sudo install -d -m 755 /etc/iggy && sudo install -o echo -g echo -m 600 /var/tmp/iggy-config.toml /etc/iggy/config.toml && rm /var/tmp/iggy-config.toml"

    just update-firewall "$SERVER" "$CONFIG"

## Version bump helpers (similar to echo-operator)

# Bump version across crates by updating rc timestamp only (no minor/patch selection)
bump-version:
    #!/bin/bash
    set -euo pipefail
    ROOT="$(pwd)"
    MAIN_TOML="$ROOT/Cargo.toml"  # workspace file

    # Extract current [workspace.package] version (BSD/macOS compatible)
    CUR=$(sed -n '/^\[workspace\.package\]/,/^\[/p' "$MAIN_TOML" | sed -n -E 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -1)
    BASE=${CUR%-rc.*}
    if [[ -z "${BASE:-}" ]]; then echo "Cannot determine base version from $MAIN_TOML" >&2; exit 1; fi
    TS=$(date -u +%Y%m%d%H%M)
    NEW_VER="${BASE}-rc.${TS}"
    echo "✅ Bumping to $NEW_VER"

    # Update workspace version in [workspace.package]
    awk -v newver="$NEW_VER" '
      BEGIN{insec=0; done=0}
      /^\[workspace.package\]/{insec=1}
      /^\[/{if ($0 != "[workspace.package]") insec=0}
      insec && !done && $0 ~ /^[[:space:]]*version[[:space:]]*=/{
        print "version = \"" newver "\""; done=1; next
      }
      {print}
    ' "$MAIN_TOML" > "$MAIN_TOML.tmp" && mv "$MAIN_TOML.tmp" "$MAIN_TOML"

    # Update standalone crates that are not in the workspace
    PFILES=(
      "$ROOT/docs/echo-docs/Cargo.toml"
    )
    for file in "${PFILES[@]}"; do
      if [[ -f "$file" ]]; then
        awk -v newver="$NEW_VER" '
          BEGIN{inpkg=0; done=0}
          /^\[package\]/{inpkg=1}
          /^\[/{if ($0 != "[package]") inpkg=0}
          inpkg && !done && $0 ~ /^[[:space:]]*version[[:space:]]*=/{
            print "version = \"" newver "\""; done=1; next
          }
          {print}
        ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
      fi
    done

    # Update lockfile
    cargo check

# Commit bumped versions (includes Cargo.lock)
bump-version-commit:
    #!/bin/bash
    set -euo pipefail
    just bump-version
    MAIN_TOML="Cargo.toml"
    new_ver=$(sed -n '/^\[workspace\.package\]/,/^\[/p' "$MAIN_TOML" | sed -n -E 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -1)
    msg="bump: ${new_ver}{{ message }}"
    git add Cargo.lock Cargo.toml docs/echo-docs/Cargo.toml 2>/dev/null || true
    if git diff --cached --quiet; then
        echo "No changes to commit."
    else
        git commit -m "$msg"
        echo "Versions bumped and committed: $msg"
    fi

# Push bumped versions
bump-version-push:
    #!/bin/bash
    set -euo pipefail
    just message="{{ message }}" bump-version-commit
    git push
