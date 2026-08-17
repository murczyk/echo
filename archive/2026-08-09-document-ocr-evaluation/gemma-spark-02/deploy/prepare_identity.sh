#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/host_guard.sh"

DUPLICATED_MACHINE_ID=7af66f30966a49b6886e00e2fce4b42f

test "$(cat /etc/machine-id)" = "$DUPLICATED_MACHINE_ID"
test -L /var/lib/dbus/machine-id
test "$(readlink /var/lib/dbus/machine-id)" = /etc/machine-id

guard_host
sudo truncate -s 0 /etc/machine-id
guard_host
sudo systemd-machine-id-setup
test -n "$(cat /etc/machine-id)"
test "$(cat /etc/machine-id)" != "$DUPLICATED_MACHINE_ID"

guard_host
sudo systemctl set-default multi-user.target
test "$(systemctl get-default)" = multi-user.target

guard_host
sudo systemctl reboot

