# Performance implementation evidence, 2026-10-12

Issue: [#3780](https://github.com/echoua/echo/issues/3780).
Current implementation branch: `3780-aor-perf`.
Worktree: `/home/ubuntu/workspace/echo-copy`.
Original benchmark baseline: `3780-perf-fixes`, based on `origin/stable` at
`bffef890f`, in `/home/ubuntu/workspace/echo-3780-perf`.
The first batch was subsequently transferred into the user's current
`3780-aor-perf` checkout at `/home/ubuntu/workspace/echo-copy`, preserving its
committed investigation archive and existing branch changes. The stable
worktree remains the original benchmark/validation baseline. Production received read-only diagnostics; no binary,
schema, settings, or service changes were deployed.

## First batch

- AOR candidate membership replaces the outer message/group/AOR join fan-out.
  Candidates project only message IDs. Both candidates and derived links keep
  their applicable message-ID bounds.
- The count-only AOR endpoint uses exact distinct-AOR cardinality, rather than
  computing unused distinct-message counts for every AOR.
- The AOR candidate query joins posts only when a post filter is present.
- Duplicate-group reconciliation projects only two IDs and gains a concurrent
  covering btree index for the three equality predicates. Its null-sender,
  ambiguous-match, transactional deletion, and settlement-requeue behavior
  remain unchanged.

[Release and recovery instructions](../../../docs/performance/3780-aor-reconciliation.md).

## AOR diagnostics on Pivnich

Installed ClickHouse: **26.3.12**. The captured request underlying the original
memory-failure fingerprint was reused privately; dates, authorized group keys,
and response contents are omitted from this archive. Each execution had an
8-second maximum and 2-GiB per-query cap. Queries were sequential and read-only;
plain plans were inspected before execution.

| Shape | Threads | Server duration | Rows read | Bytes read | Logged peak memory | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Original captured SQL | 4 | 8,009 ms | 7,731,600 | 246,653,874 | 708,982,391 B | Execution timeout, code 159 |
| Candidate membership, native SQL | 4 | 2,724 ms | 7,730,794 | 238,413,322 | 317,510,238 B | Completed, 8 AOR rows |
| Candidate membership, gateway-generated SQL | 4 | 906 ms | 7,731,843 | 237,867,476 | 418,617,321 B | Completed, 8 AOR rows |
| Candidate membership, gateway-generated SQL | automatic | 1,251 ms | 8,562,066 | 261,288,190 | 403,868,873 B | Completed, 8 AOR rows |
| Distinct-AOR count only, gateway-generated SQL | automatic | 1,713 ms | 8,569,006 | 261,508,961 | 379,350,570 B | Completed, count = 8 |

The gateway's `EXPLAIN (VERBOSE, FORMAT JSON)` showed one Foreign Scan and a
remote query containing membership/semi-join processing. The exact generated
remote SQL was then executed through the native client under the diagnostic
limits. This verifies pushdown and native execution, rather than claiming an
HTTP end-to-end latency result.

For correlation in retained `system.query_log`:

- Original: `echo-perf-3780-old-9f9c3d3001ed47ed880fe1ee1c3f813c`.
- Native rewrite: `echo-perf-3780-candidate_membership-0a32848a5e7940e4a2f5a52896a9bc62`.
- Gateway rewrite/four threads: `echo-perf-3780-gateway-54d87dc7ca144b2785ab68fc053422b9`.
- Gateway rewrite/automatic threads: `echo-perf-3780-gateway-auto-e64d7f0e075340b884ae83896dd0170f`.
- Count-only rewrite/automatic threads: `echo-perf-3780-count-gateway-auto-b2cdfd4b2c9b43a39fce9dffc5eb4439`.

The count-only plan also pushed down as one Foreign Scan, projecting one
aggregate column. It avoided the unused per-AOR message counts and returned
the same cardinality. A single run was slower than the preceding facet run;
these measurements do not establish a count-only latency improvement.

The incident's unrestricted memory peak and these bounded runs are different
experiments. The old bounded execution did not finish, so it cannot provide
a production result-equivalence comparison. Exact result equivalence is
covered with PostgreSQL-backed functional fixtures. Cache state, ongoing
ingestion, and one captured request limit the comparison; concurrency,
wide Skhid distributions, and production p95 still need validation.

## AOR diagnostic on Skhid

A retained pre-investigation request with additional filters was tested through
the same candidate-membership shape, using the gateway-generated remote SQL,
automatic threads, an 8-second limit, and a 2-GiB cap. It completed in **109 ms**
server time (154 ms client wall time), read **451,168 rows / 16,999,483 bytes**,
logged **377,764,912 B** peak memory, and returned **one AOR row**. The gateway
plan contained one Foreign Scan and remote semi-join processing.

Query ID: `echo-perf-3780-skhid-gateway-auto-06bf844d1e4f48ae8b650d437f43f068`.
This was a selective request, not a reproduction of Skhid's worst memory
failure or a controlled old/new comparison. Broad filters and concurrent
traffic remain canary/benchmark requirements on that deployment.

## Duplicate lookup benchmark

An isolated local PostgreSQL 14 database,
`wd_test_3780_index_benchmark`, held a synthetic unlogged table with the nine
production columns and **38,774,958 rows**, approximating the measured Skhid link
cardinality. Heap size was **5,092 MiB**. Sender, datasource-group, and timestamp
values were generated; this was not a restored production distribution and
the production servers run PostgreSQL 18.4.

The query selected only `id, signal_message_id`, with exact datasource-group,
timestamp, and sender predicates and an excluded message ID. Plain plans were
inspected before read-only `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`.

| Lookup | Access path | Result rows | Time | Shared hit/read blocks | Heap fetches |
| --- | --- | --- | --- | --- | --- |
| Nonnull sender before index | Parallel sequential scan | 1 | 2,927.979 ms | 15,993 / 635,823 | n/a |
| Same lookup after index | Index Only Scan | 1 | 0.456 ms | 3 / 5 | 1 |
| Null sender after index | Index Only Scan | 1 | 0.155 ms | 3 / 2 | 1 |

The equality predicates appear in `Index Cond`; the inequality remains a
filter on the tiny matching set. The concurrent index built successfully and
occupied **3,309 MiB**. The initial scan also dirtied/wrote newly loaded heap
pages, so its wall time is not a controlled cold-cache speedup ratio. The
change in access path and number of examined/read blocks is the primary
evidence. Production build duration, disk/WAL cost, and write overhead were
not measured by building an index on an incident host.

The [full plans](duplicate-lookup-plans.txt) and
[synthetic benchmark SQL](duplicate-lookup-benchmark.sql) are archived here.
The SQL refuses databases outside this task's benchmark-name prefix and
requires a fresh database; it does not drop existing tables.

## Search experiment: do not ship universal correlated probes

A read-only Pivnich probe compared the existing global search-ID UNION with
body/media/current-chunk EXISTS probes keyed by scoped message ID. It used
a frequent group from statistics, one common Russian token, the existing
deletion and group conditions, and a 5-second statement timeout. These were
diagnostic parameters, not an identified user's failing request.

| Window | Existing UNION | Correlated probes | Existing / probe shared reads |
| --- | --- | --- | --- |
| 2 hours | 3,843.289 ms | 132.276 ms | 56,949 / 656 blocks |
| 24 hours | 1,368.043 ms | 3,376.863 ms | 9,290 / 33,199 blocks |
| 168 hours | Timeout | Timeout | Incomplete |

The one-day correlated plan wrote 5,530 temporary blocks. A universal EXISTS
replacement would regress a broader query, so it was not implemented. The
next search batch needs a scoped relation/GIN-first comparison across narrow
and broad workloads and all positive/negative/OR attachment semantics.

## Verification

The standard dump was restored into dedicated functional and catalog databases; the locally
available `pg_uuidv7` extension was enabled there to satisfy existing baseline
migrations. Product migrations were not changed to repair the test setup.

An initial functional run collided with a separate migration runner and
failed on a duplicate migration record. The runners were serialized and the
existing AOR comparison subsequently passed. An expanded test compile also
caught an unavailable test helper; the fixture now inserts its post directly.
These failures do not count as successful validation runs.

Original stable validation:

| Check | Result |
| --- | --- |
| `cargo check` | Passed |
| `cargo clippy -p wdintel-rs -p echo-migration --all-targets -- -D warnings` | Passed |
| `cargo test -p wdintel-rs rer_analysis_analytics_ -- --test-threads=1` | 5 passed |
| Orphan duplicate-group AOR regression | 1 passed |
| Duplicate restoration/deletion/settlement-requeue regression | 1 passed |
| Ambiguous nonnull-sender duplicate safeguard | 1 passed |
| `just migrate-up`, and isolated catalog-database down/up round trip | Passed; final index ready and valid |
| Catalog-aware analytics check with `GITHUB_BASE_REF=stable` and restored `wd_test_3780_catalog_20261012` | Passed |
| `just build-front` | Passed |
| `npm run format:staged` | Passed; no changed frontend inputs |
| Rustfmt check of all changed Rust source files | Passed |
| `cargo fmt --all -- --check` | Existing stable formatting differences at `messenger/worker/mod.rs:1552,1592,1600`; file unchanged |

The index does not change entity columns, relations, or types, so entity
regeneration is unnecessary. No frontend or backend binding types changed.
The workspace-wide formatter differences were left intact to follow the
repository's prohibition on unrelated formatting edits.

## Validation after transfer to the current checkout

On `3780-aor-perf` in `/home/ubuntu/workspace/echo-copy`, `cargo check`,
Clippy with warnings denied, all eight database regressions, `just build-front`,
staged Prettier, and formatting of the changed Rust files passed again.
The three implementation files and index migration match the original
validated stable versions exactly. Existing branch-specific changelog entries
and migration registrations were preserved; the committed `perf.md` is unchanged.

The new index migration was applied with `just migrate-up` to
`wd_test_3780_checkout_catalog_20261012`. The catalog comparison used this
checkout's existing `origin/main` base at `9186a2f85`, applied to a fresh
standard-dump restore. The first catalog invocation stopped before capturing
the baseline because the restarted shell lacked `PGPASSWORD`. It was resumed
using the script's exact catalog SQL, explicit connection credentials and
database names, proposed application migrations, and the catalog-aware policy
checker. The before/after snapshots contain 2,113 columns; the check passed.
Snapshots are `/tmp/echo-3780-checkout-catalog-before.tsv` and
`/tmp/echo-3780-checkout-catalog-after.tsv`.

The initial baseline invocation also used the configured local `wd_files_test`
file-registry database and applied its existing baseline migrations. The resumed
invocation used the dedicated `wd_files_test_3780_checkout_catalog_20261012`
database. Production databases were not changed. A temporary test-configuration
edit was restored byte-for-byte; no configuration change is included in the patch.

Production remains unchanged. Search/admission/resource profiles and the
other batches are still pending in [fix.md](fix.md); this branch does not
demonstrate resolution of all reported 503s.
