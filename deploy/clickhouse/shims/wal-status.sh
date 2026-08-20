#!/usr/bin/env bash

command_path=/opt/echo-peerdb/current/bin/"$(basename "$0")"
[[ -x "$command_path" ]] || exit 0
exec "$command_path" "$@"
