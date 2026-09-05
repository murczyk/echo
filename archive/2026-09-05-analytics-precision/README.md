# Analytics precision hotfix — 2026-09-05

All nine active application servers were redeployed sequentially to
`0.1.1-rc.202609051117` (commit `46e7f48d0d92278509c7853896372c34734c60e8`).
All six analytics gateways run the pinned precision extension; CBR staging, CBR,
and Kupiansk remain without analytics. The final audit passed services, HTTP,
replication, cleared maintenance, configuration hashes and SHA256 checks for 572 packaged `/usr` files
on every application server. See [fleet-comparison.json](fleet-comparison.json).

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
foreign-table schemas are unchanged. A restored-database fixture demonstrated
that the ordering inner join dropped authorized, nondeleted messages without an
inbox row. Ordering now uses the same left join as primary hydration. The fresh-tail
count query also projects `created_at` through its indexed lateral query, fixing
the missing-column failure. No new upstream PR was submitted.

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

Application fixture suites pass after the forward correction: inbox 135, analysis
148, and group statistics
52 (two existing ignored cases). These cover multiplicity, exclusions, deletion,
CDC lag, backdated arrivals, exports and complete fallback. The operational log
parser has three regressions protecting final-success and all-fallback counting.
Cargo formatting/check, Clippy with all targets/features and denied warnings, staged
frontend formatting, and the frontend build pass. The read-only verifier passes
on the restored test database and rejects missing read-only settings and a
required hybrid result on an unconfigured host. Existing startup configuration
seeding is bypassed only for verification; normal startup is unchanged.
The verifier additionally compares complete message digests against stable
primary reads. Missing-inbox-row fixtures cover NULL ordering, timestamp ties,
ascending/latest requests, complete hydration parity, and deleted-candidate
revalidation. The fresh-tail fixture excludes historical arrivals from its count.

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

Detailed evidence is preserved in
`/home/ubuntu/workspace/echo-analytics-precision-20260905` (with the working copy in
`/tmp/echo-analytics-precision-20260905`). Selected evidence hashes are in
[evidence-sha256.json](evidence-sha256.json); real-data samples and raw journals
remain outside the repository. The first rollout attempt is retained separately.

## Final deployment and comparison

The final application package was built once by
[CI run 33962950485](https://github.com/echoua/echo/actions/runs/33962950485) and reused
on all nine servers. Its SHA256 is
`5a131f9c7caa55e9100d06fb70ee3f82253f4389b449d411a50cf2cae99f7fe4`;
the installed application binary SHA256 is
`45d2866b5725c3e21c4701d0a8e459c69bbd3a3a8f44cd48d32674cc37b0940b`.
The frontend build passed in CI; the 335 relevant Rust fixtures, Cargo check,
Clippy and formatting checks passed locally. CI's combined test step was skipped
by the existing workflow configuration, so it is not counted as another test run.

The user waived the remaining timed observation minimums and requested the least
disruptive recovery: fix forward, reserving rollback for serious service failures.
The earlier Pivnich restore had already started before that instruction and
finished successfully. It was then upgraded forward. No further rollback occurred.
Gate durations below cover immediate verification after controlled replays;
they do not represent the originally planned 5/15/30-minute holds.

| Server | Analytics | Controlled hybrid / primary reads | Live hybrid reads in gate | Gate seconds |
| --- | --- | ---: | ---: | ---: |
| staging | yes | 4 / 0 | 0 | 27.0 |
| kharkiv2 | yes | 4 / 0 | 0 | 27.4 |
| zp2 | yes | 5 / 0 | 461 | 27.3 |
| siversk | yes | 4 / 0 | 239 | 28.0 |
| skhid | yes | 4 / 0 | 287 | 28.3 |
| pivnich | yes | 4 / 0 | 669 | 30.2 |
| cbr-staging | no | 0 / 4 | 0 | 5.1 |
| cbr | no | 0 / 4 | 0 | 8.9 |
| kupiansk | no | 0 / 4 | 0 | 5.7 |

All 37 controlled replays matched fully hydrated primary results and complete
message digests: 25 hybrid reads and 12 primary reads on unconfigured sites.
Each site included a nonempty fixture. All six gateways passed stable source /
gateway input fingerprints, bounded join comparisons, healthy replication and
the fractional self-comparison. ZP2 message `12823417` returned no rows on either
side for `timestamp > '2026-09-05 09:07:59.026668'`; remote SQL used
`cast('2026-09-05 09:07:59.026668' as DateTime64(6, 'UTC'))`.

The final fleet audit recorded **19,258 complete hybrid inbox successes**, 342
successful primary inbox operations and **zero final inbox fallbacks**. Its
windows start at the later of the five-minute audit boundary and each site's
verification start. Quiet staging hosts are supported by explicit replays.
The JSON report keeps audit and gate windows separate; overlapping windows must
not be added together. It also retains every PostgreSQL route reason, including
`query_policy`, `unconfigured`, `analytics_skipped` and records without a final
outcome. These route-log records are distinct from completed inbox operations.

Pivnich's deployment transition included **975 successful complete PostgreSQL
inbox fallbacks** while desired-state health/reconciliation and the candidate
circuit recovered. There was one new-application count fallback timeout
(SQLSTATE `57014`) and two count-timeout completions from the previous application
around the gateway upgrade. The older application lacked complete count-operation
logging; those timeout records remain separately identified. No precision
mismatch, incomplete revalidation or affected-query timeout/circuit recurrence
was observed after the verification boundary or in the final audit.

The corrected ordering query used indexed lookups for 50 bounded Pivnich
candidates and completed in 1.186 ms. Staging plans for the actual total count,
fresh-tail count and historical gateway count completed in 0.301, 0.381 and
41.533 ms respectively. The tagged historical-count plan captured one remote execution,
reading 90,118 rows and returning one aggregate row. These are bounded plan
observations; repeated benchmarks remained confined to restored development data.

Existing findings remain visible: missing AOR assignments and network-membership
consistency checks; Signal CLI startup connection refusals; Iggy heartbeat messages
from clients that have shut down; and a recovery guard skipping a deleted message.
Earlier Siversk observations also contained unrelated Delta EXO account errors.
Legacy candidate-route warnings persist on hosts without analytics; complete
inbox diagnostics correctly identify their successful primary operations.
No warning or revalidation check was removed to obtain these results.

The report includes all nine successful deployment notification receipts and the
five earlier-attempt receipts. Application recovery packages/configuration hashes
are in `/var/backups/echo-analytics-precision-20260905/app-forward`; original
backups remain under `app`. Gateway backup paths are recorded per site in the
JSON report; Pivnich's forward upgrade uses `gateway-forward`.

No production slowlog reduction percentage is claimed without a measured
production comparison.
