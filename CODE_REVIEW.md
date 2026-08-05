# Code review

## Replicated PostgreSQL migrations

CI compares migration DDL with
`deploy/clickhouse/migration-impact.json`. Every changed Echo migration and
every updated `echo-im` or `echo-gpu` migration revision must declare its
analytics impact. The supported strategies are `excluded`,
`replicated_snapshot`, `cdc_backfill`, and `mirror_resync`.

Normal deployments must remain independently runnable for each environment.
Reject migrations that require coordinated deployment of multiple environments
or a manual analytics mirror resync unless that operational requirement was
explicitly approved by the user before implementation. For drops, renames, and
type changes on replicated tables, require a backwards-compatible
expand/migrate/contract design that the standard deployment can reconcile when
practical; declaring `mirror_resync` in the impact catalog is not sufficient
authorization by itself.

For `CREATE TABLE`, confirm whether the table belongs in
`deploy/clickhouse/env/tables-exclude.txt`. Non-excluded tables are added to
PeerDB automatically after migration; exclusion changes remain an explicit
deployment operation performed before migrations.

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

Apply this review to schema migrations shipped by application dependencies
such as `echo-im`, not only migrations in `echo-migration`.

Reviewers validate the declared strategy and the trigger safety of any DML;
they are not expected to catch deployed exclusion drift manually. Deployment
syncs the packaged exclusions before running migrations and fails if analytics
does not become healthy afterward. Do not replace that guard with a warning or
an automatic full-mirror resync.

## Architecture documentation

Require changes to deployment topology, process or worker ownership, storage,
or external integrations to update [docs/README.md](docs/README.md). Changes to
the optional analytics stack must also update
[deploy/clickhouse/README.md](deploy/clickhouse/README.md) and its operational
scripts when applicable.

For changes requiring manual deployment actions, verify that `CHANGELOG.md`
contains clear deployment instructions marked with 👷 (“Потребує мануальних
дій при деплої”).
