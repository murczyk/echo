# Code review

## Rust error context

Require every propagated fallible Rust call to attach the source location with
`.context(h!())?` or `.c(h!())?`. Do not accept a bare `?` when propagating a
`Result`; use `.c(h!())?` when converting concrete library or infrastructure
errors and `.context(h!())?` when propagating an existing application error.

## Test scope

Do not require a test for every change. Keep the default suite focused on
database-backed business logic, operational parsers, issue- or PR-linked
regressions, and critical migration, authorization, concurrency, idempotency,
or destructive-data safeguards.

Reject nonessential tests that only restate implementation details, rendered
SQL, trivial helpers, defaults, formatting, or mocks without protecting a
real failure mode. Prefer a focused fixture in an existing functional or
parser test over adding another isolated unit test.

## Duty behavior contract

For changes to Duty Neo, shared message settings/cards, or inbox ordering and
pagination, review the [Duty creation-time contract](docs/duty/README.md#creation-time-contract).
Duty must always use creation time; Analysis's time-basis preference must not
affect Duty. Require the #3546 behavior regressions to remain in the frontend CI
suite, and update the contract and acceptance tests together for intentional
behavior changes. Documentation alone does not replace executable coverage.

## Query performance

Review database access using [QUERY_PERF.md](QUERY_PERF.md). Require
production-scale plan evidence for high-risk queries and oneoffs; ORM-generated
SQL is not exempt.

## Replicated PostgreSQL migrations

Use comparable existing migration files as examples when writing new migrations.
Follow their SQL structure, up/down behavior, and error-context pattern.

CI compares migration DDL with
`deploy/clickhouse/migration-impact.json`. Every changed Echo migration and
every updated `echo-im` or `echo-gpu` migration revision must declare its
analytics impact. The supported strategies are `excluded`,
`replicated_snapshot`, `cdc_backfill`, `cdc_additive`,
`empty_table_resnapshot`, and `mirror_resync`.

Treat every schema migration as a coupled change to
`deploy/clickhouse/migration-impact.json`: review the matching entry in the
same pull request, and reject missing, stale, or incorrectly scoped impact
declarations.

For `CREATE TABLE`, confirm whether the table belongs in
`deploy/clickhouse/env/tables-exclude.txt`. Non-excluded tables are added to
PeerDB automatically after migration; exclusion changes remain an explicit
deployment operation performed before migrations.

Do not add non-nullable columns to existing tables in migrations. Add columns as
nullable and without a default, including boolean flags; interpret `NULL` in
application code when it represents an unset or false value. Existing
PostgreSQL rows then avoid an implicit value that needs a ClickHouse backfill or
mirror resync.

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

`cdc_additive` is limited to nullable column additions without defaults. Require
reviewed, bounded post-DDL DML to publish the schema on populated tables. Deployment
waits for CDC and fails on timeout without rebuilding a populated table; only an
empty table may use the targeted resnapshot fallback. Catalog checks must reject
non-additive changes, defaults, and non-nullable additions for this strategy.

Treat replicated tables as potentially empty. The `cdc_backfill` strategy is
allowed only for a table whose schema guarantees a row on every deployment;
currently that is limited to the `system_settings` singleton. Additive-column
migrations on tables expected to remain empty may use
`empty_table_resnapshot`; deployment verifies emptiness and resnapshots only
that table. Do not choose `mirror_resync` merely because a changed table is
non-empty. Require a nullable design, reviewed CDC backfill, targeted table
resnapshot, or table-replacement migration instead.

Treat `mirror_resync` as an exceptional last resort and reject it by default.
It rebuilds every mapped table, including `sigint_inbox_item` and
`signal_message`, even when the migration changes only a smaller table. Approve
it only when the change genuinely requires rebuilding `sigint_inbox_item` or
`signal_message` themselves and no scoped strategy can preserve correctness.

Every approved `mirror_resync` must add a `CHANGELOG.md` `NEXT` entry marked
with both 🚨 and 👷 and beginning with the prominent banner
`🚨🚨🚨 **MIRROR RESYNC** 🚨🚨🚨`. Require the entry to name the affected
tables, explain why a scoped strategy is impossible, state expected duration
and production load, give the exact sequential commands and fallback behavior,
and define health checks and stop conditions before the next server.

Apply this review to schema migrations shipped by application dependencies
such as `echo-im`, not only migrations in `echo-migration`.

Reviewers validate the declared strategy and the trigger safety of any DML;
they are not expected to catch deployed exclusion drift manually. Deployment
syncs the packaged exclusions before running migrations and fails if analytics
does not become healthy afterward. Do not replace that guard with a warning or
an automatic full-mirror resync.

## Configuration compatibility

When adding configuration values, prefer backward-compatible behavior for
existing deployments whose configs may not be updated at the same time. If a
new value enables an optional feature, keep that feature disabled when the
value is absent and emit a startup warning instead of breaking an existing
workflow such as user login.

## Architecture documentation

Keep `docs/README.md` small and focused on system architecture. Do not add
feature-specific implementation details, field semantics, migration notes, or
issue-by-issue descriptions. Put necessary details in focused documentation
and add an architecture-guide link only when it helps explain the architecture.
Reject additions that expand the guide without changing the architectural picture.

Require changes to deployment topology, process or worker ownership, storage,
or external integrations to update [docs/README.md](docs/README.md) only when
they change the system architecture. Changes to
the optional analytics stack must also update
[deploy/clickhouse/README.md](deploy/clickhouse/README.md) and its operational
scripts when applicable.

For changes requiring manual deployment actions, verify that `CHANGELOG.md`
contains clear deployment instructions marked with 👷 (“Потребує мануальних
дій при деплої”).
