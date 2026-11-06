#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../bin/lib.sh
source "$TEST_DIR/../bin/lib.sh"

wait_script=$TEST_DIR/../bin/wait-postgres-listen-addresses.sh
case_dir=$(mktemp -d /tmp/echo-postgres-listen-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir "$case_dir/path"
cat >"$case_dir/path/runuser" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$ECHO_TEST_LISTEN_ADDRESSES"
MOCK
cat >"$case_dir/path/ip" <<'MOCK'
#!/usr/bin/env bash
address=${*: -1}
case $address in
  127.0.0.1) printf '1: lo inet 127.0.0.1/8\n' ;;
  203.0.113.5)
    [[ -f "$ECHO_TEST_LATE_ADDRESS_FILE" ]] \
      && printf '2: eth0 inet 203.0.113.5/24\n'
    ;;
esac
exit 0
MOCK
cat >"$case_dir/path/getent" <<'MOCK'
#!/usr/bin/env bash
[[ "$2" == dualstack.test ]] || exit 2
printf '2001:db8::1 STREAM dualstack.test\n127.0.0.1 STREAM\n'
MOCK
cat >"$case_dir/path/ss" <<'MOCK'
#!/usr/bin/env bash
[[ -z "${ECHO_TEST_SS_FAILS:-}" ]] || exit 1
printf '%b' "$ECHO_TEST_SS_OUTPUT"
MOCK
chmod +x "$case_dir"/path/*
export PATH="$case_dir/path:$PATH"
export ECHO_TEST_LATE_ADDRESS_FILE=$case_dir/late-address

expect_wait() {
  local name=$1 addresses=$2 limit=$3 min_seconds=$4 max_seconds=$5 expected=$6
  local started=$SECONDS output status=0
  output=$(
    ECHO_TEST_LISTEN_ADDRESSES=$addresses \
      ECHO_POSTGRES_LISTEN_WAIT_SECONDS=$limit \
      bash "$wait_script" 18-main 2>&1
  ) || status=$?
  local elapsed=$((SECONDS - started))
  if ((status != 0 || elapsed < min_seconds || elapsed > max_seconds)) \
    || [[ "$output" != *"$expected"* ]]; then
    printf '%s: status=%s elapsed=%ss output=%s\n' \
      "$name" "$status" "$elapsed" "$output" >&2
    exit 1
  fi
}

expect_wait 'present address' 127.0.0.1 5 0 1 'ready after'
expect_wait 'localhost needs no resolver' 127.0.0.1,localhost 5 0 1 'ready after'
expect_wait 'wildcard' '*' 5 0 1 'ready after'
expect_wait 'space after comma' '127.0.0.1, localhost' 5 0 1 'ready after'
expect_wait 'hostname with a later local result' dualstack.test 5 0 1 'ready after'
expect_wait 'absent address starts anyway' 198.51.100.7 1 1 2 'starting PostgreSQL anyway'
expect_wait 'unresolvable name starts anyway' nope.invalid 1 1 2 'starting PostgreSQL anyway'
expect_wait 'unreadable setting does not wait' '' 5 0 1 'not waiting'

(sleep 1 && touch "$ECHO_TEST_LATE_ADDRESS_FILE") &
expect_wait 'address that appears during the wait' 127.0.0.1,203.0.113.5 10 1 3 'ready after'
wait

listeners='LISTEN 0 200 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 200 [::1]:5432 [::]:*\n'
export ECHO_TEST_SS_OUTPUT=$listeners
[[ -z $(missing_listen_addresses 127.0.0.1,localhost 5432) ]]
[[ $(missing_listen_addresses 127.0.0.1,10.0.0.5 5432) == 10.0.0.5 ]]
[[ -z $(missing_listen_addresses dualstack.test 5432) ]]
[[ $(missing_listen_addresses nope.invalid 5432) == nope.invalid ]]
[[ $(missing_listen_addresses '*' 5432) == '*' ]]

export ECHO_TEST_SS_OUTPUT='LISTEN 0 200 0.0.0.0:5432 0.0.0.0:*\n'
[[ -z $(missing_listen_addresses '*' 5432) ]]

export ECHO_TEST_SS_OUTPUT=''
[[ $(missing_listen_addresses 127.0.0.1 5432) == 127.0.0.1 ]]

export ECHO_TEST_SS_FAILS=1
[[ -z $(missing_listen_addresses 10.0.0.5 5432) ]]
