# Analytics routing and gateway verification — 2026-09-05

Application base: `echo/main` at `9ce5e1f5d`. Extension base: deployed
`32df74d1b26e4e4cd52fadc8c049b1a2a5847b4d` (`pgch_version() = 0.3.2`).
The extension changes are in [pg_clickhouse.patch](pg_clickhouse.patch), also
available in the separate `../pg_clickhouse-analytics` worktree. No commits or
pushes were made. The application keeps the PostgreSQL gateway.

## Implemented behavior

- Unit labels and IDs now qualify for analytics counts, facets, summaries,
  report scans and inbox candidates. Existence predicates bound replicated
  unit/network links and preserve exclusions, undefined/deleted units,
  mixed labels/IDs and saved-filter behavior.
- Media filters use bounded attachment existence predicates. Multiple links
  or attachments do not multiply candidate messages or counts.
- Recent analysis ranges and Duty initial/latest/polling requests merge
  analytics candidates with the primary created-at tail. Hydration and
  revalidation use bounded primary batches; ordering, cursor ties, deduplication
  and complete-operation fallback are retained.
- Bounded unlimited requests and reports use keyset candidate pages. Report
  limits remain unchanged. Legacy unbounded `load_latest + nolimit` reads
  retain their primary behavior; they are not enabled for analytics.
- Group activity enrichment and combined statistics use shared analytics
  services. Redis hits remain hits; raw-data misses use analytics with fallback.
  Cache writes, authorization, transaction-dependent reads and PostGIS retain
  their original connections.
- `analytics_route` records operation, connection, fallback reason and outcome.
  Inbox-specific logs also record candidate counts and primary-tail time.
- The extension composes SEMI/ANTI joins using derived-table projections,
  including equivalent join keys hidden by SEMI joins. Correlated INNER JOIN
  subplans and planner alternatives can execute remotely. Nullable `NOT IN`,
  unsupported outer-join subplans and different effective users stay local.

## Inputs and comparison boundaries

[database-boundaries.json](database-boundaries.json) records versions and restore
boundaries. Source databases ran PostgreSQL 18.4; shared gateways ran PostgreSQL
18.4 and ClickHouse 26.3.12.3. Every remote SQL check used a read-only transaction
and a 15-second statement timeout. No database refresh or source-data write was
performed for comparisons.

| Comparison | Inclusive message IDs | Unit ID | Input classification |
|---|---:|---:|---|
| Pivnich dev / gateway | 28,980,000–28,982,000 | 452 | All seven input fingerprints match |
| Skhid dev / gateway | 34,050,000–34,052,000 | 0 | Non-unit inputs match; dev has no unit links |
| Skhid source / gateway | 39,070,000–39,070,200 | 10,540 | All seven input fingerprints match |

Pivnich dev's latest message was created at `2026-09-04 23:01:16.881511`,
ID 29,011,441. Skhid dev's latest message was created at
`2026-07-29 03:09:09.175832`, ID 34,061,375. Skhid contains a future event date
in 2029, so maximum event time is not a valid restore boundary.

Fingerprints include message deletion/timestamps, inbox frequency/unit label,
unit links and unit deletion state, attachments, group links and group deletion
state. Captures before/after the runs and the completed catalog fingerprint are
recorded in [comparisons.json](comparisons.json), alongside original/revised SQL,
results, PostgreSQL execution statistics, gateway plans and remote fragments.

All seven Pivnich and Skhid source query shapes return matching results on
matching inputs. Historical Skhid media/candidate/group cases match. Its unit
cases are invalid as parity evidence: the restored dev sample has zero links,
while its gateway has 1,037 links. No observed mismatch is attributed to later
message updates/deletions in these samples. Group aggregation rows require
comparison by group key because source and ClickHouse text collations return
different orders; the application consumes these as keyed data.

## Shared gateway results with the deployed extension

Dev timings are medians of three `EXPLAIN ANALYZE` executions; the Skhid source
check uses one execution, not a repeated production benchmark. JSON result
recording is a separate execution and can have a different aggregate plan.

| Pivnich query | PostgreSQL original → bounded, ms | Gateway original → bounded, ms |
|---|---:|---:|
| Unit count | 10.686 → 1.266 | 182.575 → 190.711 |
| Unit exclusion | 7.421 → 7.752 | 158.202 → 168.246 |
| Unit + media count | 6.753 → 1.345 | 1,298.502 → 209.274 |
| Frequency facet | 7.539 → 1.488 | 198.589 → 159.796 |
| Media candidates | 7.307 → 5.007 | 47.088 → 46.288 |
| Group activity | 16.657 → 22.871 | 37.653 → 35.294 |

On the deployed Pivnich gateway, bounding the combined unit/media query reduces
the attachment fragment from 1,346,574 returned rows to 210, and the unit
fragment from 178,073 to 59. The main message fragment still returns 1,103
rows for local aggregation. Skhid's individual bounded unit/media check changes
from 1,818.655 ms to 86.356 ms with matching inputs/results.

These are not uniformly faster queries. The deployed unit fragment still reads
about 25.2 million ClickHouse rows, and attachment filtering reads about
1.88 million. Existing storage/FINAL behavior does not prune these scans well.
The application bounds reduce intermediate transfers; they do not by themselves
solve composition or ClickHouse storage pruning.

## Isolated extension verification

The modified extension was built and loaded only in an isolated PostgreSQL
18.6 installation on port 55432, with ClickHouse 26.3.12.3 on loopback. Both
binary and HTTP drivers were tested. The source sample contains 1,920 messages,
1,103 inbox rows, 1,396 unit links, 210 attachments, 1,809 group links and
200 referenced units. Its fingerprint and row counts are recorded in
`comparisons.json`; message bodies and attachment content were not copied.

All 56 baseline/revised × driver × SQL-variant real-sample results match local
PostgreSQL on identical inputs. Unit count, unit exclusion, combined unit/media
count and frequency aggregation change from local aggregate/sort plans to a
single remote foreign scan. Media candidate ordering/limits and group
aggregation remain remote.

For one binary-driver bounded unit count, the baseline performs two remote
scans returning 1,103 + 50 rows. The revised plan performs one remote scan
returning one count. The bounded unit/media count changes from three scans
returning 1,103 + 210 + 50 rows to one scan returning one count. Revised sample
reads are 4,619 and 4,829 rows respectively, with each input scanned once per
count execution. This demonstrates removal of intermediate scans/transfers on
the identical sample, not production-scale latency or storage-pruning gains.

The supplemental [mixed-label comparison](mixed-labels.json) replays a real
Pivnich label combined with an explicit unit ID and an attachment exclusion.
Source, deployed gateway, isolated baseline and isolated revised extension all
return 49. The deployed gateway takes 1,347.969 ms versus PostgreSQL's 6.016 ms;
the isolated revised plan moves the full count into ClickHouse. The tiny sample
is slower after pushdown (12.285 versus 7.118 ms), so this is evidence of remote
execution and parity, not a latency win on small data.

The new regression compares results to PostgreSQL fixtures under both drivers
and checks remote aggregate/order/limit plans. It covers duplicate links,
multiple attachments, NULLs, deleted units/messages, mixed legacy labels,
SEMI/ANTI composition, outer joins around those joins, correlated explicit
joins, aliases, table permissions and different view owners. Existing
cancellation/concurrent-scan tests also pass.

Full extension regression: 35/37 pass. The two failures also occur unchanged
on the deployed baseline: `jsonb_exists` expects command tags suppressed by
pg_regress, and `union_pushdown` has stale output-column widths. They are
snapshot differences, not new query/result failures. The new regression passes.

Application verification uses the dedicated databases
`wd_test_analytics_fixes_20260905` and
`wd_files_test_analytics_fixes_20260905`, restored from the standard test dump.
The analysis suite passes 108 tests, the inbox suite passes 133 tests, the
statistics suite passes 52 tests (two existing ignored tests), and the added
backdated-arrival/deletion revalidation test passes. The missing-cache-batch
group timeline regression also passes, confirming raw activity is returned
when aggregate batches are absent. These cover permissions,
mixed labels/IDs, deleted/undefined units, attachment multiplicity, candidate
pages beyond 1,000 rows, cursor ties, report limits/exports, timeouts,
cancellation and circuit recovery. The local NLP service was started for the
inbox suite. `cargo check`, Clippy with all targets/features and warnings denied,
`cargo fmt --check`, and `just build-front` were run.

## Ordered application deployment and canary verification

Following the updated authorization, `just deploy-from-local --server
<host> --silent` was run first for `echo-staging`, then for `echo-kharkiv2`.
Staging verification completed before the Kharkiv2 deployment began. Both
installed the same application binary, SHA-256
`3f26566cb4505b1e179abb289921e1561d9a84d2b5373183b4e3160cf8f730f2`.
The package version remains `0.1.1~rc.202609031828-1`; the binary hash identifies
this local build. No pending migrations were found.

Staging's final verifier initially encountered an existing reconciliation
lock after installation succeeded. The lock holder completed successfully;
rerunning `source-verify-deploy.sh` passed. Kharkiv2's deployment completed with
exit status zero, including the analytics verifier. Maintenance was cleared
on both hosts.

Both hosts passed these post-deployment checks:

- Application, background worker, report worker, socket and NLP services active;
  service restart counters zero.
- Frontend and login over nginx HTTPS returned 200; NLP readiness returned 200;
  an unauthenticated inbox request returned 401.
- Analytics replication heartbeat healthy; queries as `echo_analytics` succeed.
- Installed application binary matches the locally built package. Shared
  gateway extension hashes match their pre-deployment values.

[deployment-verification.json](deployment-verification.json) contains the
checks, binary/library hashes, log summaries, query plans, results, input
fingerprints, execution statistics and ClickHouse query-log records.

| Post-deployment comparison | Inclusive IDs | Result |
|---|---:|---|
| Staging historical/deleted sample | 3,506,000–3,506,200 | Seven query shapes match; unit/media counts are empty |
| Staging active sample | 3,507,235–3,507,435 | Seven query shapes match; eight active messages and six media candidates |
| Kharkiv2 active sample, unit 40,972 | 9,215,755–9,215,955 | Seven query shapes match; nonempty units, facets and media candidates |
| Kharkiv2 combined unit/media, unit 42,771 | Same canary IDs | Original/revised source/gateway counts all equal seven; application role also returns seven |

All seven input fingerprints match across source/gateway and before/after
captures for each comparison. The staging samples do not establish positive
unit/media-intersection coverage; the additional canary case does.

The canary's single bounded unit/media execution changed from 288.480 to
59.160 ms on the existing gateway for unit 42,771, returning seven matches. Candidate latency was
40.809 versus 87.136 ms in this sample. These are individual bounded checks,
not repeated production benchmarks or evidence of uniform latency improvement.

Staging runtime logs independently captured 56 successful analytics group
activity operations and four successful analytics inbox-count operations,
with no analytics error/fallback entries in the captured interval. Kharkiv2
configured its analytics pools and passed direct query checks; no authenticated
analytics request was observed in its captured runtime interval. Manual HTTP
checks verify serving and authentication boundaries, not a logged-in workflow.

Both runtimes emitted a connection-refused diagnostic while attempting to
configure verbose Signal logging on localhost:8083. The identical staging
diagnostic is present before this deployment. This is separate from the
analytics checks; it is not reported as a newly fixed integration.

The isolated PostgreSQL, ClickHouse and NLP test processes were stopped after
verification; local build outputs, test data and evidence were retained.

The modified extension remains local to the isolated test environment. The
application and analytics control bundle were deployed through the normal
local-deployment recipe; no shared gateway extension was replaced. Therefore
the isolated fork's pushdown improvements are not claimed as deployed.

## Reproduction and limits

Use `scripts/analytics/compare_reads.py` for bounded source/gateway reads and
`scripts/analytics/replay_sample.py` for the isolated installation described
above. Production hosts allow one performance execution per query. Raw run
logs and ClickHouse query-log captures are in
`/tmp/echo-analytics-verification`; their relevant plans, rows read/returned and
execution counts are retained in the local comparison artifact.

Nullable joined `NOT IN` remains local to preserve PostgreSQL three-valued
logic. Arbitrary outer-join subplans and different user mappings also remain
local. Matching the local sample does not establish correctness or performance
for every SQL shape. Broad historical updates becoming newly eligible during
CDC lag are still subject to the configured analytics freshness policy; the
primary created-at tail specifically covers fresh and backdated arrivals.

The ≥95% production PostgreSQL slowlog reduction remains a later rollout/soak
acceptance target. No claim of that reduction is made here.

## Follow-up from the fleet rollout

The first published application build exposed recurring 25-second cancellations
on ZP2 for legacy-unit correlated subqueries. Whole-operation PostgreSQL fallback
succeeded, but the shared circuit repeatedly opened. Skhid and Pivnich deployment
was held while correcting the query shape.

The deployed `32df74d` extension supports correlated subqueries with flat FROM
entries, but refuses explicit JOIN trees. Legacy-unit EXISTS now uses comma
FROM entries plus the identical inner-join predicates in WHERE. Aliases,
NULL behavior, network/frequency active windows and link bounds are retained.
This compatibility change does not require replacing the shared extension.

[gateway-compatibility.json](gateway-compatibility.json) records bounded ZP2
comparisons. For 200 dated candidate IDs and network 2,857, both forms return
six messages; one execution changes from 3,342.323 ms with local aggregation
to 174.415 ms with a remote aggregate. Another sample returns zero in both
forms (3,940.759 versus 134.579 ms). A nullable-date sample causes the old
parameterized subplan to reject NULL DateTime parameters; the remote form
returns the correct empty match without sending a nullable correlation value
as a non-null parameter. These gateway-only samples did not capture input
fingerprints before/after, so timings are diagnostic individual reads, not a
controlled benchmark. The existing database-backed mixed/undefined/denied
legacy-unit regression passes with the revised application query builder.


## Deployed gateway cursor compatibility

Longer observation of the corrected ZP2 application found a separate recurring
count timeout combining sender exclusions and a timestamp/ID cursor. The
baseline gateway leaves PostgreSQL row comparisons local, preventing adjacent
joins and filters from being pushed down. Analytics pagination now expands the
same lexicographic condition into scalar comparisons; primary pagination keeps
its tuple condition. NULL cursor handling is unchanged.

[cursor-compatibility.json](cursor-compatibility.json) records the actual SQL,
original gateway plan, revised execution statistics and a twelve-case SQL
comparison including timestamp ties and NULL rows. The affected live request
previously cancelled around 25 seconds. A single revised historical-tail check
completed in 84.018 ms, returning 130 and 128 rows from two remote fragments.
The deployed baseline still performs its anti join and final aggregate locally.
This is bounded production diagnostic evidence, not a repeated benchmark or a
new source/gateway fingerprint parity comparison. The application fixture
compares primary and analytics counts for both cursor directions and date sorts.
