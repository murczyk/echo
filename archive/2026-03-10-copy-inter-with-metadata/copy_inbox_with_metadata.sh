#!/usr/bin/env bash
set -euo pipefail

sudo -u postgres psql -At wd <<'SQL'
copy (
 select json_build_object('id', id, 'content', body) from signal_message where created_at > '2026-01-01' and (body like '%CC%' or body like  '%CG%' or body like '%⬅️%' or body like '%➡️%')
) to '/var/tmp/message_with_metadata.json' with csv header;
SQL
