# Code review

## Replicated PostgreSQL migrations

Flag `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` on PeerDB-replicated tables.
PeerDB propagates the column, but it does not populate existing ClickHouse rows
with the PostgreSQL default. Require an explicit source-row backfill or a full
mirror resync before analytical queries rely on the historical value.
