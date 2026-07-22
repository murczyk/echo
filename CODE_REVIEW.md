# Code review

## Replicated PostgreSQL migrations

Flag `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` on PeerDB-replicated tables.
PeerDB propagates the column, but it does not populate existing ClickHouse rows
with the PostgreSQL default. Require an explicit source-row backfill or a full
mirror resync before analytical queries rely on the historical value.

## Architecture documentation

Require changes to deployment topology, process or worker ownership, storage,
or external integrations to update [docs/README.md](docs/README.md). Changes to
the optional analytics stack must also update
[deploy/clickhouse/README.md](deploy/clickhouse/README.md) and its operational
scripts when applicable.
