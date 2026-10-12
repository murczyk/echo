# API request limits

Authenticated users with the exact `Api` role share one request quota per login
across `/api/` endpoints, sessions, and HTTP workers in one server process.
Users without that role, unauthenticated requests, and paths outside `/api/`
continue through their existing handlers. Role classifications and active quota
settings are cached for one second across HTTP workers, with concurrent cache
misses sharing one lookup. Requests using cached values, including rejected
attempts, do not query PostgreSQL for throttling. The role cache retains at most
4096 logins. Role and settings changes apply after cache expiry on the next
request. Throttling runs before the PostgreSQL-backed agent-route checks.
Limits do not replace endpoint authorization.

The default quota replenishes one request every 500 ms (2 requests per second)
and allows a burst of 5 requests. An administrator can change both positive
integer values on the system settings API tab. Each value is at most 2147483647;
their product must not exceed 9223372036854 ms. The form, API, and database reject
unsupported values.

An exhausted quota returns HTTP 429 with a JSON `error` and a `Retry-After`
header containing the wait rounded up to at least one second. Clients should
wait before retrying. Quotas live in memory: restarting a process restores full
bursts, and separate server processes have independent quotas. Inactive quota
entries are cleaned up when requests arrive, at most once per minute.

## Settings reconciliation

Saving settings without one or both quota fields preserves the corresponding
active values. Explicit JSON `null` also preserves an active value; a missing
active row or a nullable historical value uses the defaults. Saving unrelated
settings keeps existing quota balances. Activating a historical revision uses
its saved quotas, with the same defaults for nullable values.

Settings saves, history activations, and report-toggle revisions use one
transaction-scoped PostgreSQL advisory lock before reading active settings.
Concurrent partial saves therefore preserve each other's quota changes and
leave one active revision. New revisions set their update timestamp after
acquiring the lock, so a waiting transaction's start time cannot make its
settings snapshot appear stale.

A change to either effective quota value rebuilds the shared limiter and grants
fresh bursts. Settings snapshots are ordered by `(updated_at, id)`: an older
concurrent request cannot revert a newer applied snapshot or grant another
burst. A newer revision with unchanged quotas advances the revision without
resetting balances.

## Migration and analytics

`m20261012_155351_api_rate_limit` adds nullable integer columns without defaults
and backfills the active system settings row to 500 ms and burst 5. Historical
rows retain `NULL`. Its `cdc_backfill` declaration in
`deploy/clickhouse/migration-impact.json` follows the guaranteed populated
system settings table. The update changes only the new columns; the table has
no user UPDATE triggers. The ordinary analytics deployment guard waits for the
columns in raw ClickHouse, current-state views, and the PostgreSQL gateway and
requires a green analytics health check. No full mirror resync is required.

Validate cumulative schema reconciliation against `main` using a dedicated
database restored from the standard dump:

```bash
source deploy/setup_test_database.sh 3788_review
GITHUB_BASE_REF=main TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh
```

Regression coverage lives in
`wdintel-rs/src/server/api_rate_limit.rs`,
`wdintel-rs/src/system_settings/mod.rs`, and
`wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/index.spec.tsx`.
