# Analytics precision hotfix — 2026-09-05

## Provenance and release scope

The deployment fork is `codex/v0.3.2-search-backports`, based on deployed
`32df74d1b26e4e4cd52fadc8c049b1a2a5847b4d`. It does not include a wholesale
upstream update or the `codex/string-json-path-pushdown` branch.

- Formatter [2f66605](https://github.com/ClickHouse/pg_clickhouse/commit/2f666050851f31fea988d38c3f4ef25251106096)
  was cherry-picked with attribution as `867e2ca`.
- [`to_timestamp()` #338](https://github.com/ClickHouse/pg_clickhouse/pull/338)
  commit `630018f257f36602c0684b8e0d9cd2453d407dde` was cherry-picked with attribution as `12116af`.
- Prepared analytics-worktree changes matched the previously archived patch before
  integration. The worktree and original untracked vendor directories were preserved.
- SEMI/ANTI inner-dependent condition placement was adapted from Josh Ventura’s
  [#347](https://github.com/ClickHouse/pg_clickhouse/pull/347), pinned at
  `f49ddb02ae29b042db844a455f41aad22a3e1ea8`, with co-author attribution.
- The resulting deployment commit is
  [`6e00148a1849452d5a96086b5454bc186bf52c99`](https://github.com/k-bx/pg_clickhouse/commit/6e00148a1849452d5a96086b5454bc186bf52c99),
  artifact revision `v0.3.2-echo.2`.

HTTP schemas, primary authorization, hydration/revalidation, complete PostgreSQL
fallback, and the already-shipped application routing remain intact. Imported
foreign-table schemas are unchanged. The suspected missing-inbox-row ordering
issue remains untouched. No new upstream PR was submitted.

## Verification before promotion

PostgreSQL 18.6 and ClickHouse 26.3.12.3: 36 of 38 extension regression tests
pass. The only failures are the two archived baseline snapshots:
`jsonb_exists` expects command tags suppressed by pg_regress, and
`union_pushdown` has stale psql column widths. Their rows and plans agree;
[the exact differences](baseline-snapshot-differences.diff) are retained.
No new unexplained failure is accepted.

The suite covers both drivers, HTTP insert compatibility, cancellation, connection
recovery, permissions, correlated joins, SEMI/ANTI composition, nullable parameters,
and query-scoped insert cleanup. New precision fixtures cover timestamp and
timestamptz, three session zones, custom/generic prepared plans, NULLs, microsecond
neighbors, ID tie-breaking, both cursor directions, inclusive bounds, initial/latest
reads, pages, casts, and inserts. Timestamp/timestamptz session-zone conversions
remain local where PostgreSQL semantics require them.

Application functional fixtures pass: inbox 134, analysis 108, and group statistics
52 (two existing ignored cases). These cover multiplicity, exclusions, deletion,
CDC lag, backdated arrivals, exports and complete fallback. The operational log
parser has three regressions protecting final-success and all-fallback counting.
Cargo formatting/check, Clippy with all targets/features and denied warnings, staged
frontend formatting, and the frontend build pass. The read-only verifier passes
on the restored test database and rejects missing read-only settings and a
required hybrid result on an unconfigured host. Existing startup configuration
seeding is bypassed only for verification; normal startup is unchanged.

The archived Pivnich dev sample was reused with exactly the original ID boundary
28,980,000–28,982,000 and SHA256
`a634d687c312f0f48757a3b628b7763c5522cf83c93d73c6777e24df289d5a25`.
All 56 result comparisons match; 304 uniquely tagged remote executions have zero
exceptions. Plans, remote SQL, read/returned rows, and timings were captured.
Repeated measurements ran only against the restored isolated sample. See
[sample-summary.json](sample-summary.json). Aggregate remote counts include the
result read and three plan executions, rather than representing one query.

A new ZP2 fractional sample covers IDs 12,823,397–12,823,437. Primary and gateway
input fingerprints match and the primary sample remained stable. The old gateway
incorrectly returns message 12823417 for `timestamp > TIMESTAMP
'2026-09-05 09:07:59.026668'`; PostgreSQL returns no rows. Its remote SQL is:

```sql
SELECT id, "timestamp" FROM echo_analytics.signal_message
WHERE (("timestamp" > '2026-09-05 09:07:59')) AND ((id = 12823417))
```

The fix must retain `.026668` remotely and return no rows at every promotion gate.
A projected comparison alone is insufficient evidence because PostgreSQL may
compute it locally; the reproduced predicate is in WHERE.

## Artifacts and operational evidence

The extension-only artifact was built once on the Debian 13 builder for PostgreSQL
18. Its exact library hash and commit are in [extension-build.json](extension-build.json),
and its archive hash is in [extension-SHA256SUMS](extension-SHA256SUMS).
The installer saves rollback artifacts/configuration hashes, coordinates the
reconciliation lock/timers, stops the gateway cluster before replacing its library,
and verifies the checksum and reads after restarting.

Detailed local evidence is retained in
`/tmp/echo-analytics-precision-20260905`; selected input and verification hashes are
in [evidence-sha256.json](evidence-sha256.json). Real-data samples remain outside the
repository. Fleet results, observation windows, full-operation outcomes/fallback
reasons, and notification receipts will be added after deployment.

No production slowlog reduction percentage is claimed without a measured
production comparison.
