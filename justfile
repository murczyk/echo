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
since_ts := "1645664400000"
till_ts := "1961204400000"
datasource_id := "1"
message := ""
unit := ""

default:
    @just --list

_print-servers:
    @echo "❌ Server parameter not recognized. Can be one of: echo-zaporizhzha, echo-kherson, echo-donetsk, echo-soledar. Value: {{ server }}"

evaluate:
    @just --evaluate

dev-front:
    (cd wdintel-web && npx elm-land server)

# now with build!
dev-front2:
    (cd wdintel-web && npm ci && npx elm-land build && npx elm-land server)

build-front:
    (cd wdintel-web && npm run build)

dev-back:
    (cd wdintel-rs && {{ rust_log }}cargo watch -- cargo run -- --mode=debug server {{ dev_back_args }})

dev-back-noproj:
    # Run backend without `proj` feature for local development
    (cd wdintel-rs && {{ rust_log }}cargo watch -- cargo run --no-default-features -- --mode=debug server {{ dev_back_args }})

dev-back-sudo:
    (cd wdintel-rs && cargo build && {{ rust_log }}sudo ./target/debug/wdintel-rs --mode=debug server {{ dev_back_args }})

# mkdir -p ~/Downloads/storage

# see wdintel-py/README.md
dev-py:
    #!/bin/bash
    set -euxo pipefail
    echo "Setting up Python environment..."
    # check if wdintel-rs/wdintel-py/.venv doesn't exist and create it
    if ! test -d "wdintel-rs/wdintel-py/.venv"; then
        echo "Creating wdintel-rs/wdintel-py/.venv"
        # try python3.11, then python3, then python
        for PY in python3.11 python3 python; do
          if command -v $PY >/dev/null 2>&1; then
            echo "Using $PY to create venv"
            $PY -m venv wdintel-rs/wdintel-py/.venv
            break
          fi
        done
    fi
    source wdintel-rs/wdintel-py/.venv/bin/activate

    # Check if requirements are already installed by comparing timestamps
    REQUIREMENTS_FILE="wdintel-rs/wdintel-py/requirements.txt"
    INSTALLED_MARKER="wdintel-rs/wdintel-py/.venv/.requirements_installed"

    if [ ! -f "$INSTALLED_MARKER" ] || [ "$REQUIREMENTS_FILE" -nt "$INSTALLED_MARKER" ]; then
        echo "Installing Python dependencies..."
        pip install -r "$REQUIREMENTS_FILE"
        touch "$INSTALLED_MARKER"
    else
        echo "Python dependencies already up to date, skipping installation"
    fi

    # Check if spacy model is already downloaded
    if ! python3 -c "import spacy; spacy.load('ru_core_news_md')" 2>/dev/null; then
        echo "Downloading spacy model..."
        python3 -m spacy download ru_core_news_md
    else
        echo "Spacy model already downloaded, skipping"
    fi

    FLASK="$PWD/wdintel-rs/wdintel-py/.venv/bin/flask"
    STORAGE="$HOME/Downloads/storage"
    (cd wdintel-rs/wdintel-py && WD_CALLSIGNS_SPM=$STORAGE/wiki.model WD_CALLSIGNS=$STORAGE/callsigns20230512.pt $FLASK --app service --debug run)

dev-sigint-worker:
    (cd wdintel-rs && cargo run -- --mode=debug sigint-worker)

setup-dev:
    # todo: setup everything?
    npm install uglify-js -g

gen-seaorm:
    (cd wdintel-rs && sea-orm-cli generate entity --with-serde both -u postgres://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd -o src/entities)
    python3 deploy/patch_seaorm.py

gen-elm:
    (cd wdintel-rs && cargo run -- --mode=debug gen-elm)
    elm-format --yes wdintel-web/src/Bindings.elm

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

    npx elm-land build && elm-test-rs

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

ci-test-be:
    bash deploy/run_backend_tests.sh

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

deploy:
    #!/bin/bash
    set -euo pipefail
    # Enable tracing if DEBUG=1 or TRACE=1 is set in environment
    if [[ "${DEBUG:-0}" == "1" || "${TRACE:-0}" == "1" ]]; then
      set -x
    fi
    if [[ "{{ server }}" == "" ]]; then
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

    # Use SSH to the builder host and query redis on localhost there
    # Fixed builder host; can override by setting env BUILDER
    BUILDER="${BUILDER:-echo-gpu}"
    CI_SSH_TARGET="$BUILDER"
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$CI_SSH_TARGET" true 2>/dev/null; then
      echo "Cannot SSH to $CI_SSH_TARGET; required to check Redis keys" >&2
      exit 1
    fi

    printf "\n🚀🚀🚀 deploying %s 🚀🚀🚀\n\n" "{{ server }}"

    # Notify Discord at the start of deployment including local hostname
    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"deploying {{ server }} (version $VERSION); waiting for CI from $(hostname)\"}" \
      'https://discord.com/api/webhooks/1406993055956865125/7i5kRgYYJNqlROHRij2eZ3bLWmHQa1X3zpgmZ2Q7--jhO3GjXUq4sJ0Xm6yYPy1lf20B' || true

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
    # Quiet update/install (stdout suppressed for update; install in -qq)
    ssh {{ server }} 'sudo apt-get -qq update > /dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get -y -qq install echo-install wdintel-rs echo-docs'
    # Success notification
    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"✅ Deployed {{ server }} (version $VERSION) via apt-get\"}" \
      'https://discord.com/api/webhooks/1406993055956865125/7i5kRgYYJNqlROHRij2eZ3bLWmHQa1X3zpgmZ2Q7--jhO3GjXUq4sJ0Xm6yYPy1lf20B' || true

deploy-old:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
     just _print-servers; exit 1;
    fi
    # Notify Discord at the start of legacy deployment including local hostname
    curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"content\":\"legacy deploy-old {{ server }} from $(hostname)\"}" \
      'https://discord.com/api/webhooks/1406993055956865125/7i5kRgYYJNqlROHRij2eZ3bLWmHQa1X3zpgmZ2Q7--jhO3GjXUq4sJ0Xm6yYPy1lf20B' || true
    if [[ "{{ server }}" == "jvln" ]]; then
        just _jvln-deploy;
    else
        just builder={{ builder }} server={{ server }} _echo-generic-deploy-old;
    fi

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

copy-db:
    #!/bin/bash
    set -euxo pipefail

    if [[ "{{ server }}" == "echo-zaporizhzha" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "jvln" ]]; then \
        just _jvln-copy-db; \
    elif [[ "{{ server }}" == "echo-kherson" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-donetsk2" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-soledar" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-soledarnist" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-lyman" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-kharkiv" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-siversk" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-kherson2" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-volyn2" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-pivnich" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-skhid" ]]; then \
        just server={{ server }} _copy-db; \
    elif [[ "{{ server }}" == "echo-kupiansk" ]]; then \
        just server={{ server }} _copy-db; \
    else \
        just _print-servers; exit 1; \
    fi

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

    ssh -t {{ server }} '(cd ~/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    scp {{ server }}:~/Downloads/wd-{{ dt1 }}.pgrestore ~/Downloads/
    ssh -t {{ server }} 'rm ~/Downloads/wd-{{ dt1 }}.pgrestore'
    set +x
    echo "Run: sudo -u postgres dropdb --force wd"
    echo "Run: sudo -u postgres psql postgres -c \"CREATE DATABASE wd\""
    echo "Run: sudo -u postgres pg_restore -d wd ~/Downloads/wd-{{ dt1 }}.pgrestore"
    set -x

copy-db-gpu:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    just server={{ server }} target='echo-gpu' copy-db-to-target

copy-db-to-target:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    if [[ "{{ target }}" == "" ]]; then
        echo "❌ `target` parameter not recognized. Value: {{ target }}"; exit 1;
    fi
    ssh -t {{ server }} '(cd ~/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    ssh -t {{ server }} 'gzip -c ~/Downloads/wd-{{ dt1 }}.pgrestore > /tmp/wd-{{ dt1 }}.pgrestore.gz'
    scp {{ server }}:/tmp/wd-{{ dt1 }}.pgrestore.gz ~/Downloads/
    ssh -t {{ server }} '(rm ~/Downloads/wd-{{ dt1 }}.pgrestore && rm /tmp/wd-{{ dt1 }}.pgrestore.gz) | echo "ok"'
    scp ~/Downloads/wd-{{ dt1 }}.pgrestore.gz {{ target }}:/var/tmp/
    ssh -t {{ target }} '(cd /var/tmp && gunzip wd-{{ dt1 }}.pgrestore.gz)'
    ssh -t {{ target }} "sudo -u postgres psql -c 'drop database {{ pgdb }} with (FORCE)'"
    ssh -t {{ target }} "sudo -u postgres psql -c 'create database {{ pgdb }}'"
    ssh -t {{ target }} "sudo -u postgres pg_restore -d {{ pgdb }} /var/tmp/wd-{{ dt1 }}.pgrestore && sudo rm /var/tmp/wd-{{ dt1 }}.pgrestore"
    rm ~/Downloads/wd-{{ dt1 }}.pgrestore.gz | echo "ok"

copy-db-local:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ server }}" == "" ]]; then
         just _print-servers; exit 1;
    fi
    echo 'this command requires sudo access'
    sudo ls
    ssh -t {{ server }} '(cd ~/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ dt1 }}.pgrestore && ls -lah wd-{{ dt1 }}.pgrestore)'
    ssh -t {{ server }} 'gzip -c ~/Downloads/wd-{{ dt1 }}.pgrestore > /tmp/wd-{{ dt1 }}.pgrestore.gz'
    scp {{ server }}:/tmp/wd-{{ dt1 }}.pgrestore.gz ~/Downloads/
    ssh -t {{ server }} '(rm ~/Downloads/wd-{{ dt1 }}.pgrestore && rm /tmp/wd-{{ dt1 }}.pgrestore.gz) | echo "ok"'
    mv ~/Downloads/wd-{{ dt1 }}.pgrestore.gz /var/tmp/
    (cd /var/tmp && gunzip wd-{{ dt1 }}.pgrestore.gz)
    sudo -u postgres psql -c 'drop database {{ pgdb }} with (FORCE)'
    sudo -u postgres psql -c 'create database {{ pgdb }}'
    sudo -u postgres pg_restore -d {{ pgdb }} /var/tmp/wd-{{ dt1 }}.pgrestore && sudo rm /var/tmp/wd-{{ dt1 }}.pgrestore

setup-b2:
    ssh {{ server }} 'sudo pip3 install -U b2'

# before running, make sure to read/setup "Backups" section in server.md

# also run just setup-b2
backup:
    ssh -t {{ server }} '(cd ~/Downloads && PGPASSWORD="{{ pgpwd }}" pg_dump --user wd -Fc wd > wd-{{ server }}-{{ dt1 }}.pgrestore && ls -lah wd-{{ server }}-{{ dt1 }}.pgrestore)'
    ssh -t {{ server }} '(cd ~/Downloads && sudo gpg --encrypt --recipient 'Echo' wd-{{ server }}-{{ dt1 }}.pgrestore && ls -lah wd-{{ server }}-{{ dt1 }}.pgrestore.gpg)'
    ssh -t {{ server }} 'sudo chown $USER:$USER ~/Downloads/wd-{{ server }}-{{ dt1 }}.pgrestore.gpg'
    ssh -t {{ server }} '(cd ~/Downloads && B2_APPLICATION_KEY_ID={{ backup_key_id }} B2_APPLICATION_KEY={{ backup_key }} b2 upload-file echouabackup ./wd-{{ server }}-{{ dt1 }}.pgrestore.gpg backup/wd-{{ server }}-{{ dt1 }}.pgrestore.gpg)'
    ssh -t {{ server }} 'rm ~/Downloads/wd-{{ server }}-{{ dt1 }}.pgrestore.gpg'
    ssh -t {{ server }} 'rm ~/Downloads/wd-{{ server }}-{{ dt1 }}.pgrestore'

_jvln-deploy: _jvln-deploy-front _jvln-deploy-back

_jvln-deploy-front:
    (cd wdintel-web && npm ci && npx elm-land build)
    rm ./wdintel-web/static/dist/wdintel-rs || true
    rsync -az -i --progress --exclude .git ./wdintel-web/dist/ kon@jvln:/fast/kon/www/wd/ ;
    echo "Front-end is ready. Now open https://wildducks.online"

_jvln-deploy-back:
    #!/bin/bash
    set -euxo pipefail

    SERVER=jvln
    bw sync
    NAME="echo-config-$SERVER"
    res=$(bw list items --pretty $NAME | jq -r '[.[] | select(.name=="'$NAME'")][0].notes')
    if [[ "$res" == "null" ]]; then
        echo "❌ Config not found in Bitwarden"
        exit 1
    else
        echo "$res" > /tmp/config-bitwarden.toml
    fi
    diff_result=$(diff /tmp/config-server.toml /tmp/config-bitwarden.toml || true)
    if [[ -z "$diff_result" ]]; then
        echo "✅ Configs are equal"
    else
        echo "❌ Configs are different"
        echo "diff: $diff_result"
        read -p "Do you want to update the config on the server? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            scp /tmp/config-bitwarden.toml $SERVER:/tmp/config.toml && ssh $SERVER 'sudo mv /tmp/config.toml /etc/echo/config.toml'
            ssh $SERVER 'sudo systemctl restart wdintel-rs wdintel-rs-sigint-worker'
            echo "✅ Config updated and echo restarted"
        else
            echo "❌ Config not updated"
        fi
    fi

    ssh jvln '(cd /fast/kon/workspace/echo-dev && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh jvln '(source .profile && cd /fast/kon/workspace/echo-dev/wdintel-rs && /fast/kon/.cargo/bin/cargo build --release)'
    ssh jvln sudo systemctl stop wdintel-rs
    ssh jvln 'rm /fast/kon/www/wd/dist/wdintel-rs || true'
    ssh jvln 'cp /fast/kon/workspace/echo-dev/wdintel-rs/target/release/wdintel-rs /fast/kon/www/wd/dist/'
    ssh jvln sudo systemctl start wdintel-rs
    rm /tmp/config-server.toml /tmp/config-bitwarden.toml || true
    echo "Back-end is ready. Now open https://wildducks.online"

_echo-generic-deploy:
    #!/bin/bash
    set -euxo pipefail
    set +x | echo 'skipping set +x, probably ubuntu build'
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    ssh {{ server }} 'sudo apt-get update'
    ssh {{ server }} 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y echo-install wdintel-rs'

# todo delete
_echo-generic-deploy-old:
    #!/bin/bash
    set -euxo pipefail
    set +x | echo 'skipping set +x, probably ubuntu build'
    if [[ "{{ server }}" == "" ]]; then
        just _print-servers; exit 1;
    fi
    if [[ "{{ builder }}" == "" ]]; then
        echo "❌ Builder parameter not recognized. Value: {{ builder }}"; exit 1;
    fi
    set -x
    just builder={{ builder }} _echo-generic-deploy-front
    just builder={{ builder }} server={{ server }} _echo-generic-deploy-back

_echo-generic-deploy-front:
    ssh {{ builder }} '(cd workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh {{ builder }} '(cd workspace/echo/wdintel-web && . ~/.nvm/nvm.sh && npx npm ci && npx elm-land build)'

_echo-generic-build-rs:
    ssh {{ builder }} '(cd workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh {{ builder }} '(cd workspace/echo && touch wdintel-rs/build.rs && $HOME/.cargo/bin/cargo deb -p wdintel-rs)'

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

build-geo-screenshot:
    ssh {{ builder }} '(cd workspace/map-bot && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
    ssh {{ builder }} '(cd workspace/map-bot/geo-screenshot && $HOME/.cargo/bin/cargo deb)'
    # TODO: determine version from Cargo.toml
    rsync --progress {{ builder }}:workspace/map-bot/geo-screenshot/target/debian/geo-screenshot_0.1.0-1_amd64.deb ~/Downloads/

deploy-geo-screenshot:
    #!/bin/bash
    set -euxo pipefail

    if [[ "{{ server }}" == "" ]]; then
        echo "❌ Server parameter not recognized. Value: {{ server }}"; exit 1;
    fi
    if [[ "{{ builder }}" == "" ]]; then
        echo "❌ Builder parameter not recognized. Value: {{ builder }}"; exit 1;
    fi

    just builder={{ builder }} build-geo-screenshot

    # TODO: determine version from Cargo.toml
    rsync --progress ~/Downloads/geo-screenshot_0.1.0-1_amd64.deb {{ server }}:Downloads/
    ssh {{ server }} 'sudo apt-get install -y xvfb libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev libxkbcommon-dev libssl-dev'
    ssh {{ server }} 'cd Downloads && sudo dpkg -i geo-screenshot_0.1.0-1_amd64.deb'
    echo "geo-screenshot deploy completed succesfully"

build-docker:
    docker buildx build --platform linux/amd64 .

setup-py:
    @if [[ "{{ server }}" == "echo-zaporizhzha" ]]; then \
        just _echo-zaporizhzha-setup-py; \
    else \
        just _print-servers; exit 1; \
    fi

_echo-zaporizhzha-setup-py:
    scp deploy/wdintel-py.service echo-zaporizhzha: && ssh -t echo-zaporizhzha 'sudo mv wdintel-py.service /etc/systemd/system/'
    ssh -t echo-zaporizhzha sudo systemctl daemon-reload
    ssh -t echo-zaporizhzha sudo systemctl enable wdintel-py

_echo-zaporizhzha-setup-sigint-worker:
    scp deploy/wdintel-rs-sigint-worker.service echo-zaporizhzha: && ssh -t echo-zaporizhzha 'sudo mv wdintel-rs-sigint-worker.service /etc/systemd/system/'
    ssh -t echo-zaporizhzha sudo systemctl daemon-reload
    ssh -t echo-zaporizhzha sudo systemctl enable wdintel-rs-sigint-worker

echo-zaporizhzha-forward-postgresql:
    echo "Forwarding echo-zaporizhzha's postgresql port to localhost:6432"
    ssh -nNT -L 6432:localhost:5432 echo-zaporizhzha

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

migrate-up:
    cd echo-migration && DATABASE_URL=postgresql://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd cargo run -- up

migrate-down:
    cd echo-migration && DATABASE_URL=postgresql://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd cargo run -- down

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

builder-build-docs:
    #!/bin/bash
    if [[ "{{ builder }}" == "echo-gpu" ]]; then
      ssh {{ builder }} '(cd ~/workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
      ssh {{ builder }} '(cd ~/workspace/echo/docs && zola build)'
      ssh {{ builder }} '(cd ~/workspace/echo/docs/echo-docs && PATH=$HOME/.local/bin:$PATH /home/ubuntu/.cargo/bin/cargo deb)'
      rsync {{ builder }}:~/workspace/echo/docs/echo-docs/target/debian/echo-docs_0.1.0-1_amd64.deb ~/Downloads/
    else
      echo "❌ Builder parameter not recognized. Value: {{ builder }}"; exit 1;
    fi

deploy-docs:
    @if [[ "{{ server }}" == "" ]]; then \
        just _print-servers; exit 1; \
    fi

    just builder={{ builder }} builder-build-docs
    rsync --progress ~/Downloads/echo-docs_0.1.0-1_amd64.deb {{ server }}:Downloads/
    ssh -t {{ server }} 'cd Downloads && sudo dpkg -i echo-docs_0.1.0-1_amd64.deb'

fmt:
    just --fmt --unstable
    (cd echo-migration && cargo fmt)
    (cd wdintel-rs && cargo fmt)
    (cd wdintel-rs && cargo clippy --all-targets --all-features -- -D warnings)

setup-kibana-local:
    #!/bin/bash
    sudo mkdir -p /etc/kibana
    sudo cp deploy/kibana/env.example /etc/kibana/.env
    sudo cp deploy/kibana/compose.yaml /etc/kibana/compose.yaml
    (cd /etc/kibana && sudo docker compose up -d)

setup-kibana-hammer:
    #!/bin/bash
    ssh hammer 'sudo mkdir -p /etc/kibana'
    scp deploy/kibana/env-hammer hammer:~ && ssh hammer 'sudo mv ~/env-hammer /etc/kibana/.env'
    scp deploy/kibana/compose.yaml hammer:~ && ssh hammer 'sudo mv ~/compose.yaml /etc/kibana/compose.yaml'
    ssh hammer 'cd /etc/kibana && sudo docker compose up -d'

setup-vector-local:
    #!/bin/bash
    sudo rm -rf /etc/vector
    sudo mkdir -p /etc/vector
    sudo cp deploy/vector/vector-echo.yaml /etc/vector/vector.yaml
    sudo cp deploy/vector/env.example /etc/default/vector
    sudo sh -c 'echo "PGPASSWORD={{ pgpwd }}" >> /etc/default/vector'
    sudo systemctl enable vector && sudo systemctl daemon-reload
    sudo systemctl restart vector

setup-vector-local-hammer:
    #!/bin/bash
    sudo rm -rf /etc/vector
    sudo mkdir -p /etc/vector
    sudo cp deploy/vector/vector-echo.yaml /etc/vector/vector.yaml
    sudo cp deploy/vector/env-hammer /etc/default/vector
    sudo sh -c 'echo "PGPASSWORD={{ pgpwd }}" >> /etc/default/vector'
    sudo systemctl enable vector && sudo systemctl daemon-reload
    sudo systemctl restart vector

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

config-deploy:
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
      'https://discord.com/api/webhooks/1406993055956865125/7i5kRgYYJNqlROHRij2eZ3bLWmHQa1X3zpgmZ2Q7--jhO3GjXUq4sJ0Xm6yYPy1lf20B' || true
    bw_sync "{{ server }}" "echo-config-{{ server }}" "/etc/echo/config.toml" "wdintel-rs"

stop-processing:
    ssh {{ server }} 'sudo systemctl stop wdintel-rs-sigint-worker'
    ssh {{ server }} 'sudo systemctl stop echo-signal-cli'
    ssh {{ server }} 'sudo systemctl stop echo-whatsapp'

resume-processing:
    ssh {{ server }} 'sudo systemctl start wdintel-rs-sigint-worker'
    ssh {{ server }} 'sudo systemctl start echo-signal-cli'
    ssh {{ server }} 'sudo systemctl start echo-whatsapp'

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

# see echo-greptimedb-toml in bitwarden for /etc/greptimedb/config.toml config
deploy-greptimedb:
    #!/bin/bash
    set -euxo pipefail

    SERVER=echo-greptime

    . deploy/utils.sh

    # put config.toml from bitwarden into /etc/greptimedb/config.toml
    bw_sync $SERVER echo-greptimedb-toml /etc/greptimedb/config.toml echo-greptimedb

    # put echo-greptimedb-auth from bitwarden into /etc/greptimedb/auth.txt
    bw_sync $SERVER echo-greptimedb-auth /etc/greptimedb/auth.txt echo-greptimedb

    # for now, manually scp deploy/greptimedb/echo-greptimedb.service to server's systemd
    scp deploy/greptimedb/echo-greptimedb.service $SERVER:/tmp/
    ssh $SERVER 'sudo mv /tmp/echo-greptimedb.service /etc/systemd/system/echo-greptimedb.service'
    ssh $SERVER 'sudo systemctl daemon-reload'
    ssh $SERVER 'sudo systemctl enable echo-greptimedb'
    ssh $SERVER 'sudo systemctl restart echo-greptimedb'

setup-server:
    ssh {{ server }} 'sudo wdintel-rs --mode=live oneoff-install'

setup-server-interactive:
    ssh {{ server }} 'sudo wdintel-rs --mode=live oneoff-install --interactive'

_build-whatsapp-bin-local:
    (cd echo-whatsapp/whatsmeow/echo-whatsapp && /usr/local/go/bin/go mod tidy && /usr/local/go/bin/go build)
    mv echo-whatsapp/whatsmeow/echo-whatsapp/echo-whatsapp deploy/echo-whatsapp/echo-whatsapp

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
    scp ./deploy/wd-init.pgrestore {{ server }}:~/Downloads
    ssh -t {{ server }} "sudo mv ~/Downloads/wd-init.pgrestore /tmp/wd_init.pgrestore"
    ssh -t {{ server }} "sudo -u postgres psql -c 'drop database wd with (FORCE)'"
    ssh -t {{ server }} "sudo -u postgres psql -c 'create database wd'"
    ssh -t {{ server }} "sudo -u postgres pg_restore -d wd /tmp/wd_init.pgrestore"

oneoff-reprocess-units-search-index:
    ssh echo-volyn2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'
    ssh echo-zaporizhzha2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'
    ssh echo-kherson2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'
    ssh echo-donetsk2 -t 'wdintel-rs --mode=live oneoff-reprocess-units-search-index' || echo 'skipping...'

# build and copy deb and binary for echo-install
builder-build-echo-install:
    #!/bin/bash
    set -euxo pipefail
    if [[ "{{ builder }}" == "" ]] ; then
        echo "❌ builder parameter not recognized. value: {{ builder }}"; exit 1;
    fi
    ssh {{ builder }} '(cd ~/workspace/echo && git fetch origin && git clean -df && git checkout {{ branch }} && git pull)'
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
