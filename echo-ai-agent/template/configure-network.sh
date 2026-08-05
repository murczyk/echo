#!/usr/bin/env bash

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

set -euo pipefail

echo_hostname=${1:?Echo hostname is required}

[[ $EUID -eq 0 ]] || {
  printf '[echo-ai-agent-template] ERROR: configuration must run as root\n' >&2
  exit 1
}
if [[ ${#echo_hostname} -gt 253 ]] \
  || ! grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' \
    <<<"$echo_hostname"; then
    printf '[echo-ai-agent-template] ERROR: invalid Echo hostname\n' >&2
    exit 1
fi

sed -i '/# echo-ai-agent$/d' /etc/hosts
printf '127.0.0.1 %s # echo-ai-agent\n' "$echo_hostname" >>/etc/hosts
nginx -t
systemctl reload nginx
