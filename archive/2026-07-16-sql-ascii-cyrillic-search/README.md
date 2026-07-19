# SQL_ASCII breaks Cyrillic full-text search

## Incident

On 2026-07-16, searching `echo-cbr` for lowercase Cyrillic text such as
`артемон` returned no messages even though the text was present.

The affected database had been initialized as `SQL_ASCII` with `C` collation
and character classification. PostgreSQL therefore parsed a Cyrillic span as
`blank`, produced an empty `websearch_to_tsquery`, and stored no Cyrillic
lexemes in `tsvector` columns. Case-insensitive Cyrillic `ILIKE` also did not
fold uppercase to lowercase.

Example diagnostics:

```sql
SELECT datname, pg_encoding_to_char(encoding), datcollate, datctype
FROM pg_database
WHERE datname = 'wd';

SELECT alias, token, dictionary, lexemes
FROM ts_debug('russian', 'Артемон');

SELECT websearch_to_tsquery('russian', 'артемон'),
       to_tsvector('russian', 'Артемон');
```

Affected output was `SQL_ASCII | C | C`, a `blank` token, and empty query and
vector values. Healthy UTF-8 output classifies `Артемон` as a `word` and
produces the lexeme `артемон`.

Database encoding cannot be repaired safely with `ALTER DATABASE` or by
editing PostgreSQL catalogs. `pg_upgrade` also preserves the original database
encoding. The safe fix is a logical dump and restore into a newly created
UTF-8 database.

## Hosts checked

| Host | Before | Action on 2026-07-16 |
| --- | --- | --- |
| `echo-cbr` | `SQL_ASCII`, `C`, `C` | Migrated to `UTF8`, `en_US.UTF-8`; rebuilt search vectors |
| `echo-cbr-staging` | `SQL_ASCII`, `C`, `C` | Migrated to `UTF8`, `en_US.UTF-8`; rebuilt search vectors |
| `echo-staging` | `UTF8`, `en_US.UTF-8` | No change; Cyrillic full-text search passed |
| `echo-kharkiv2` | `UTF8`, `en_US.UTF-8` | No change; Cyrillic full-text search passed |

The affected hosts retain the original database as
`wd_sql_ascii_20260716` and the final logical dump as
`/var/tmp/wd-utf8-cutover-20260716.dump`. The isolated preflight databases and
dumps were removed after validation. The post-cutover `echo-cbr` backup is
`20260627-112939F_20260716-143146I`.

`echo-cbr-staging` had a local PostgreSQL 14 cluster, but its
`wd-echo-staging` pgBackRest repository reported PostgreSQL 18 backups. It was
not treated as a verified host-specific backup. The local final logical dump
and renamed original database provide its rollback copies. Investigate the
shared staging backup stanza separately before relying on it.

## Safe migration runbook

Use a host-specific backup stanza and verify that its reported PostgreSQL
version, WAL timeline, database size, and latest backup really belong to the
target host. Do not rely only on the stanza name.

```bash
SERVER=echo-example
STANZA=wd-echo-example

ssh "$SERVER"
cd /tmp

df -h /var/lib/postgresql /var/tmp
pg_lsclusters
sudo -u postgres pgbackrest \
  --config=/etc/pgbackrest/pgbackrest.conf \
  --config-include-path=/etc/pgbackrest/conf.d \
  --stanza="$STANZA" info
```

Inspect the database and active clients before writing anything:

```bash
sudo -u postgres psql -X -d postgres -P pager=off <<'SQL'
SELECT datname,
       pg_encoding_to_char(encoding) AS encoding,
       datcollate,
       datctype,
       pg_size_pretty(pg_database_size(datname)) AS size
FROM pg_database
WHERE datname = 'wd';

SELECT pid, usename, application_name, client_addr, state
FROM pg_stat_activity
WHERE datname = 'wd'
ORDER BY pid;
SQL
```

Take a fresh backup when the stanza is verified:

```bash
sudo -u postgres pgbackrest \
  --config=/etc/pgbackrest/pgbackrest.conf \
  --config-include-path=/etc/pgbackrest/conf.d \
  --stanza="$STANZA" --type=incr backup
```

### Rehearse with an isolated restore

Choose unique names and confirm they do not exist before continuing:

```bash
DATE=$(date -u +%Y%m%d)
PREFLIGHT="wd_utf8_preflight_$DATE"
PREFLIGHT_DUMP="/var/tmp/wd-utf8-preflight-$DATE.dump"

sudo -u postgres psql -X -d postgres -c \
  "SELECT datname FROM pg_database WHERE datname = '$PREFLIGHT'"
test ! -e "$PREFLIGHT_DUMP"

sudo -u postgres pg_dump --format=directory --jobs=2 \
  --file="$PREFLIGHT_DUMP" wd
sudo -u postgres createdb --owner=postgres --template=template0 \
  --encoding=UTF8 --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8 \
  "$PREFLIGHT"
sudo -u postgres pg_restore --jobs=2 --exit-on-error \
  --dbname="$PREFLIGHT" "$PREFLIGHT_DUMP"
```

Rebuild the regular `tsvector` columns. The generated
`device_name.search_tsv` column is recalculated by the restore itself.

```bash
sudo -u postgres psql -X -d "$PREFLIGHT" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE sigint_unit
SET search_tsv = to_tsvector('russian', name);

DELETE FROM sigint_search;
INSERT INTO sigint_search (id, search_tsv)
SELECT id, to_tsvector('russian', body_noheader->>'body')
FROM sigint_inbox_item;
COMMIT;

ANALYZE sigint_unit;
ANALYZE sigint_search;
SQL
```

Validate row counts against the source, extensions, migrations, indexes, all
search-vector columns, and a Cyrillic query:

```bash
sudo -u postgres psql -X -d "$PREFLIGHT" -P pager=off <<'SQL'
SELECT current_setting('server_encoding');
SELECT count(*) FROM signal_message;
SELECT count(*) FROM sigint_inbox_item;
SELECT count(*) FROM sigint_search;
SELECT count(*), max(version) FROM seaql_migrations;
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT count(*) AS invalid_indexes
FROM pg_index
WHERE NOT indisvalid OR NOT indisready;
SELECT count(*) AS unit_vector_mismatches
FROM sigint_unit
WHERE search_tsv IS DISTINCT FROM to_tsvector('russian', name);
SELECT count(*) AS device_vector_mismatches
FROM device_name
WHERE search_tsv IS DISTINCT
      FROM to_tsvector('simple', coalesce(name, ''));
SELECT to_tsvector('russian', 'Бензовоз Артемон чушпан')
       @@ websearch_to_tsquery('russian', 'артемон') AS matches;
SQL
```

Both mismatch counts must be zero, `invalid_indexes` must be zero, and
`matches` must be true. Do not cut over if any restore or validation differs
from the source.

### Final consistent restore and cutover

Stop the socket first so an incoming request cannot reactivate the server.
Keep nginx running; it will return a temporary upstream error during the
maintenance window.

```bash
TARGET="wd_utf8_cutover_$DATE"
OLD="wd_sql_ascii_$DATE"
FINAL_DUMP="/var/tmp/wd-utf8-cutover-$DATE.dump"

sudo systemctl stop wdintel-rs.socket
sudo systemctl stop wdintel-rs.service wdintel-rs-bgworker.service wdintel-py.service

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE datname = 'wd' AND pid <> pg_backend_pid()"
```

Record source counts, then make the final dump only after all writers are
stopped:

```bash
SOURCE_COUNTS=$(sudo -u postgres psql -X -d wd -At -F '|' -c \
  "SELECT (SELECT count(*) FROM signal_message),
          (SELECT count(*) FROM sigint_inbox_item),
          (SELECT count(*) FROM sigint_search),
          (SELECT count(*) FROM seaql_migrations)")

sudo -u postgres pg_dump --format=directory --jobs=2 \
  --file="$FINAL_DUMP" wd
sudo -u postgres createdb --owner=postgres --template=template0 \
  --encoding=UTF8 --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8 \
  "$TARGET"
sudo -u postgres pg_restore --jobs=2 --exit-on-error \
  --dbname="$TARGET" "$FINAL_DUMP"

sudo -u postgres psql -X -d "$TARGET" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE sigint_unit
SET search_tsv = to_tsvector('russian', name);

DELETE FROM sigint_search;
INSERT INTO sigint_search (id, search_tsv)
SELECT id, to_tsvector('russian', body_noheader->>'body')
FROM sigint_inbox_item;
COMMIT;

ANALYZE sigint_unit;
ANALYZE sigint_search;
SQL

TARGET_COUNTS=$(sudo -u postgres psql -X -d "$TARGET" -At -F '|' -c \
  "SELECT (SELECT count(*) FROM signal_message),
          (SELECT count(*) FROM sigint_inbox_item),
          (SELECT count(*) FROM sigint_search),
          (SELECT count(*) FROM seaql_migrations)")
test "$SOURCE_COUNTS" = "$TARGET_COUNTS"
```

Repeat the preflight validation queries against `TARGET`. Do not swap names
unless the counts match and all validations pass.

With no connections to either database, make the reversible name swap:

```bash
sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE wd RENAME TO $OLD"
sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $TARGET RENAME TO wd"

sudo systemctl start wdintel-rs.socket
sudo systemctl start wdintel-rs.service wdintel-rs-bgworker.service wdintel-py.service
```

Validate the active database and application:

```bash
sudo -u postgres psql -X -d wd -P pager=off <<'SQL'
SELECT pg_encoding_to_char(encoding), datcollate, datctype
FROM pg_database
WHERE datname = 'wd';

SELECT count(*) AS invalid_indexes
FROM pg_index
WHERE NOT indisvalid OR NOT indisready;

SELECT to_tsvector('russian', 'Бензовоз Артемон чушпан')
       @@ websearch_to_tsquery('russian', 'артемон') AS matches;
SQL

curl --fail --silent --show-error http://127.0.0.1:8081/api-public/ping
systemctl is-active wdintel-rs.socket wdintel-rs.service \
  wdintel-rs-bgworker.service wdintel-py.service nginx
sudo journalctl -u wdintel-rs.service -u wdintel-rs-bgworker.service \
  --since '10 minutes ago' --no-pager -p err
```

Keep the final logical dump and `$OLD` database until application validation
and a post-cutover backup are complete. Remove the isolated preflight database
and dump after successful cutover. Remove `$OLD` only after the agreed rollback
retention period.

## Rollback

Stop writers and terminate connections as above. Preserve the failed UTF-8
database under a new name, then restore the original name and restart services:

```bash
FAILED="wd_utf8_failed_$(date -u +%Y%m%d_%H%M%S)"

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE wd RENAME TO $FAILED"
sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $OLD RENAME TO wd"

sudo systemctl start wdintel-rs.socket
sudo systemctl start wdintel-rs.service wdintel-rs-bgworker.service wdintel-py.service
```
