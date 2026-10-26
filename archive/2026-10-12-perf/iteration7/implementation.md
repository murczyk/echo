# Stabilize ClickHouse outages: implementation and delivery (#3780)

Branch: `3780-stabilize-clickhouse`, based on the existing `stable` checkout at
`5511181ff`. No rebase or base-branch change was performed.

## Changes

- Unit-ID inbox candidate/count queries constrain both equal join inputs before
  native hash construction. The ordinary-unit OR direct-ID branch retains its
  existing behavior, and source authorization/revalidation remain authoritative.
- The gateway user receives per-query and aggregate-user memory ceilings, a
  four-thread ceiling and a thirty-two-query concurrency ceiling, each enforced
  with `MAX` and `MIN 1` constraints. Defaults are 25% of 50% of the server memory budget
  per query and 50% together; Skhid's budgets are approximately 2.2/8.8 GiB.
  PeerDB, administration, monitoring and the server memory limit are unchanged.
- Control activation, initial setup and normal reconciliation apply/check these
  settings without restarting ClickHouse. A settings-read or write failure stops
  reconciliation instead of claiming success. `--check` is read-only.
- Native query/user memory and concurrency rejections use bounded source
  fallback as `analytics_resource_limit`, preserving analytics for unrelated
  reads. Total-server memory errors still open the existing circuit.
- Callsign morphology uses the existing batch API, checks response cardinality
  and retains original input order, normalization, offsets and retry semantics.
- Inbox reprocessing acquires its highlight job before invalidating derived
  tokens, following the worker's lock order. Jobs and tokens remain atomic.

No migration, code generation, attachment-history copy, resnapshot, reconciliation
of historical data, queue purge or queue retry reset is needed.

## Production-scale read diagnostics

Gateway `EXPLAIN (VERBOSE, FORMAT JSON)` ran first; both tested query shapes
remained one complete foreign scan. Native SELECTs then ran sequentially with
an **8-second execution limit, 2-GiB query cap and two or four threads**. These
limits applied only to the diagnostic requests, not the deployed application.
The retained [native plans](unit-inbox-plans.txt) omit private selector values.

| Scope | Original | Additional message-side unit predicate |
| --- | --- | --- |
| Captured two-unit scope, empty result, two threads | Query-memory rejection at 2 GiB | 0 rows, 6,262 ms, 162,849,901 peak bytes |
| Same authorization/history scope, an active unit with results, four threads | Query-memory rejection at 2 GiB | 20 rows, 6,184 ms, 1,979,839,882 peak bytes |

The nonempty original failed after 2,627 ms while building the join; that failure
is not a faster successful result. The successful candidate read 273,895,118 raw
rows, so the memory fix does not establish a bounded historical scan or a latency
SLA. Cache state, CDC and concurrent workloads were uncontrolled. Removing one
duplicate access semi-join or additionally removing GROUP BY still exceeded
2 GiB, so neither unproven simplification was implemented.

A sweep of 12,784 finished/failed initial gateway queries in 11:35:30–12:05:00
observed a maximum of 17 overlapping queries and 7.26 seconds at sixteen or more.
The default concurrency ceiling is therefore 32, retaining headroom above that
observed burst. The sweep excludes in-flight queries and is not a capacity test.

For a local fixture of 256 synthetic callsigns, three sequential scalar/batch
pairs returned identical ordered morphology results. Lexeme HTTP requests fell
from 256 to one; median loopback time was 117.6 ms versus 12.2 ms. This isolates
round trips and does not measure live queue throughput or NLP model latency.

## Validation

All checks below passed. The dedicated databases are
`wd_test_3780_stabilize_clickhouse` and
`wd_files_test_3780_stabilize_clickhouse`; the source was restored from the
standard test dump. Tests cover the new circuit behavior, unit IDs together with
header-unit OR and denied IDs, normal highlight offsets/morphology, and the
highlight/reprocessing lock-order regression. Local ClickHouse uses the same
26.3.12.3 executable as Skhid, with isolated ports, users, data and configuration.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo check -p wdintel-rs --all-targets --all-features` | Passed |
| `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings` | Passed |
| Issue 3780 regressions, including lock order and native/FDW error forms | 24 passed; one existing ignored test |
| Extended existing unit-ID regression | Passed |
| Existing callsign highlighting integration fixtures | 4 passed |
| Local ClickHouse enforcement | Query/user memory, concurrency, upper ceilings and all four zero-disable attempts behaved as expected |
| Deployment limit/reconciliation/control-bundle/memory/deploy-verification tests | Passed |
| `just build-front` | Passed |

Local native enforcement used scaled memory limits; it is not a concurrent
production benchmark. The test user could lower its limits, but attempts to
raise the memory ceiling or disable any of the four limits with zero were
rejected. Per-query memory, aggregate-user memory and concurrent-query rejection
were independently exercised on the pinned executable.

## Skhid delivery and canary

The branch is prepared for the user to deliver; this work does not deploy it.
Use the normal approved Skhid deployment with the backend and its matching
analytics control bundle. Control activation applies the gateway limits before
application traffic resumes. The local package/control release handshake remains
required. No service or package command in this document is approval to run it.

Before deployment retain the gateway user's entries from
`system.settings_profile_elements`, including values and constraints, for an
exact settings rollback if needed. After deployment, read
`/opt/echo-analytics/current/bin/reconcile-gateway-limits.sh --check` on the paired
analytics host and inspect the existing health row without running a heartbeat
or health writer as a read-only check.

Compare matched 10–15-minute windows and a 30–60-minute peak canary. Include empty
and nonempty unit-ID pages/counts, combined header-unit OR ID filters, ordinary
Duty traffic, broad Fuzzy search and tagged/AOR facets. Track useful completions,
whole-request p95/tails, total-server versus query/user memory errors, admission
rejections, circuit reasons, source 503s/block work, replication freshness and
messenger queue oldest age/attempts. A lower native error count caused by source
fallback or quicker rejection is insufficient by itself.

Stop expansion for result/access differences, repeated total-server memory
errors, increased source failures, sustained admission rejections or worsening
ingestion/replication. Backend rollback may retain the new schema-free limits.
Removing the limits requires first reverting the control bundle and then
restoring the four prior gateway settings/constraints, with explicit approval
for that separate operation. Do not reset retry counters or delete stuck
snapshots automatically; observe their next normal retry after deployment.
