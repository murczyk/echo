#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
policy=99-echo-gpu-maintenance

[[ $EUID -eq 0 ]] || {
  printf 'install-host-policy.sh must run as root on the Incus GPU host\n' >&2
  exit 1
}
command -v incus >/dev/null
command -v apt-config >/dev/null
incus info echo-nuextract3 >/dev/null
install -o root -g root -m 0644 "$SCRIPT_DIR/$policy" "/etc/apt/apt.conf.d/$policy"
# shellcheck disable=SC2016
apt-config dump | python3 -c '
import re
import subprocess
import sys

patterns = [
    re.compile(line.split("\"", 2)[1])
    for line in sys.stdin
    if line.startswith("Unattended-Upgrade::Package-Blacklist:: ")
]
rows = subprocess.check_output(
    ["dpkg-query", "-W", "-f=${binary:Package}\t${db:Status-Status}\n"], text=True
).splitlines()
packages = [line.split("\t")[0].split(":")[0] for line in rows if line.endswith("\tinstalled")]
unprotected = [
    name for name in packages
    if "nvidia" in name and not any(pattern.match(name) for pattern in patterns)
]
if unprotected:
    sys.exit("NVIDIA packages missing from unattended-upgrade exclusions: " + ", ".join(unprotected))
print("NVIDIA packages require coordinated maintenance; other update settings are preserved")
'
