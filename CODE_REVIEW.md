# Code review

## Replicated PostgreSQL migrations

For `CREATE TABLE`, confirm whether the table belongs in
`deploy/clickhouse/env/tables-exclude.txt`. Non-excluded tables are added to
PeerDB automatically after migration; exclusion changes remain an explicit
deployment operation.

Flag `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` on PeerDB-replicated tables.
PeerDB propagates the column, but it does not populate existing ClickHouse rows
with the PostgreSQL default. Require an explicit source-row backfill or a full
mirror resync before analytical queries rely on the historical value.

For every added column on a replicated table, require the migration or
deployment notes to define how PeerDB will observe a post-DDL row change.
Quiet tables need a reviewed, trigger-safe row touch in the migration or an
explicit table/mirror resync; do not add generic no-op updates. Do not consider
the deployment complete until the column is present in the raw ClickHouse
table, current-state view, PostgreSQL gateway, and the analytics health check
is green.

## Architecture documentation

Require changes to deployment topology, process or worker ownership, storage,
or external integrations to update [docs/README.md](docs/README.md). Changes to
the optional analytics stack must also update
[deploy/clickhouse/README.md](deploy/clickhouse/README.md) and its operational
scripts when applicable.

For changes requiring manual deployment actions, verify that `CHANGELOG.md`
contains clear deployment instructions marked with 👷 (“Потребує мануальних
дій при деплої”).
