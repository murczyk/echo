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

For React tests, every retained default-suite test must carry a truthful
`@test-scope` admission annotation: an operational parser fixture, a safeguard
that names its concrete harmful outcome, or an Echo issue/PR-linked regression.
File-level annotations are permitted only for homogeneous parser fixtures.
See `.github/skills/test-scope-policy/SKILL.md` and
`docs/frontend/react-behavior-contracts/README.md` for the contributor decision
tree and migration rules.

React Vitest specs under `src/ts/react` are direct children of the nearest
production-owned `__tests__` directory, with exactly one `__tests__` path
segment and no test-owned directory below it. Do not accept recovery,
characterization, nested-test, temporary holding paths, or placement
exceptions. Use descriptive names for collisions and preserve resolved imports
and `vi.mock` targets when relocating tests. Playwright remains in `tests/e2e`.
Behavior contracts must name complete, existing repository-relative test paths,
or use `No direct default-suite test; behavior is preserved by this contract.`.
Removing a nonqualifying test must not leave user-visible behavior undocumented.
Dynamic test titles and `.each` declarations remain subject to admission at the
actual test invocation. For Playwright, an Echo-linked regression annotation
and the literal `@regression` title tag must agree; `e2e:regression` selects
title tags, not source comments.

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
`replicated_snapshot`, `cdc_backfill`, `empty_table_resnapshot`, and
`mirror_resync`.

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

Require changes to deployment topology, process or worker ownership, storage,
or external integrations to update [docs/README.md](docs/README.md). Changes to
the optional analytics stack must also update
[deploy/clickhouse/README.md](deploy/clickhouse/README.md) and its operational
scripts when applicable.

For changes requiring manual deployment actions, verify that `CHANGELOG.md`
contains clear deployment instructions marked with 👷 (“Потребує мануальних
дій при деплої”).
