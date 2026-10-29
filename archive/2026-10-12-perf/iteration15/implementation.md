# Pivnich query load and reply coordination (#3780)

29 October 2026. Local changes on `3780-pivnich-iteration15`, from `stable` at
`c8cd0f079`, following the [release comparison](findings.md). No remote
deployment, service/configuration change, migration or repair was performed.
A new function/trigger migration was prepared and applied only to local test
databases.

## Changes

- Remove the second direct-unit membership predicate from analytics inbox
  counts and candidates. Retain the shared unit-filter builder's predicate,
  ranges on both message/inbox inputs, access/deletion checks, denied IDs,
  named-unit OR direct-ID behavior and fresh-tail boundaries. Remove the unused
  helper that generated the duplicate.
- Retry replicated heartbeat reads rejected specifically by shared-user memory
  or concurrent-query limits within the existing probe deadline. If that budget
  expires, return status 75 and update diagnostic detail/LSNs only. The previous
  health decision and successful timestamp remain unchanged; consumers still
  reject it once their configured freshness budget expires. Ordinary gateway
  errors and explicit service/mirror/slot failures still fail immediately.
- Extend the existing database-backed unit-ID regression to compare full and
  historical analytics digests with source counts/minimum timestamps across
  allowed, denied, deleted, empty and multiple-ID cases. Extend the existing
  health-probe safeguard for persistent memory/capacity errors, recovery within
  the probe budget, and ordinary gateway errors.

- Replace the global reply-thread advisory lock with one shared database
  protocol covering affected canonical messages, source inbox/outbox receipts,
  relationships and cached thread identities. Rust locks source/canonical seeds
  before resolving mappings; row triggers coordinate SQL writes and endpoint
  deletion. Missing parents, deduplication across datasources and old/new
  canonical mappings share the necessary keys. Zero-match relationship updates
  no longer lock every importer.
- Discover the complete affected component, sort its hashed keys, acquire them,
  and discover again after waiting. If new identities appeared, roll back the
  locks acquired by that attempt and retry. Transaction and lock budgets bound
  waits; fixed-snapshot writers are rejected. Native workers retain their
  complete-item retry on transaction failures. Ordinary row/advisory deadlocks
  remain possible when a transaction extends multiple components.
- Remove calendar splitting for historical pages, inbox digests and every
  analysis count/facet, including full-range probes followed by month/day
  retries. Source counts aggregate over the full requested period in SQL.
  Default text-search SQL uses the ordinary pool timeout capped at 30 seconds;
  default HTTP is 60 seconds. Explicit search overrides remain
  supported. Native message-ID batches and network-activity aggregation retain
  their separate bounded strategies.

The native plan/read/memory evidence is in [measurements.json](measurements.json).
The prototype keeps the same remaining predicate as the implementation; it is
not a deployed gateway/HTTP acceptance test. Existing native memory/concurrency
and freshness limits remain unchanged.
The source search defaults above replace the previous 90-/600-second defaults.

## Validation

Passed locally on the final sources, using dedicated source/file databases
restored from the standard test dump:

- 34 distinct Rust regressions: 13 reply storage/concurrency tests, one reply API
  test, two full-period search/pagination tests, the combined and separate count
  endpoint regression, six read/cancellation/admission/budget checks, two runtime
  configuration checks, seven native ID-batching tests, unit/media/access paging,
  and resource-limit circuit handling. The counts exercise all facets over a
  nine-month period with Fuzzy/Exact/Substring filters and both time bases.
- `cargo check -p wdintel-rs --all-targets --all-features` and strict
  `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings`.
- New migration applied locally, rollback/reapply checked transactionally, and
  fixed-snapshot writer rejection checked. Catalog-aware analytics migration
  policy passed with `GITHUB_BASE_REF=stable` on another standard-dump database.
- Temporary SeaORM generation using the recipe's CLI/patches confirmed all 289
  entity field/type maps unchanged. The existing enum patch needed formatting
  before application. Existing column/relation ordering drift was left out;
  repository entities and frontend bindings remain unchanged.
- Full `just build-front` and 14 Chromium regressions in
  `wdintel-web/tests/e2e/analysis-search-modes.spec.ts` and
  `wdintel-web/tests/e2e/message-reply-threads.spec.ts`.
- Health-probe timeout/resource/recovery safeguards passed again. Gateway
  resource-limit reconciliation, desired-state reconciliation, source-deploy
  verification and shell syntax checks also passed for the preceding changes.
- `cargo fmt --all -- --check` accepts all changed files, with the unchanged
  baseline exceptions below. `git diff --check` passed.

The whole-workspace `cargo fmt --all -- --check` reports pre-existing differences
in generated `wdintel-rs/src/entities/mod.rs`, generated
`wdintel-rs/src/entities/prelude.rs`, and `wdintel-rs/src/messenger_ingest/mod.rs`.
Those files match the branch base and remain unchanged; no unrelated formatter
edits were introduced. The existing `proc-macro-error2` future-incompatibility
notice remains outside this change. The Chromium checks mock APIs; no concurrent
real-backend HTTP replay was performed. These local checks do not establish production acceptance.

## Rollout boundary and remaining work

The heartbeat change ships in the analytics control bundle; deploying only the
application binary does not install it. Any real-environment rollout requires
separate approval naming the target and operation. The reply change needs a
coordinated writer stop, function/trigger migration,
and API/worker restart from matching new binaries; see the
[rollout procedure](../../../docs/message-replies.md#lock-protocol-rollout).
It changes no table columns and needs no analytics resnapshot.

After an approved rollout, compare complete unit-filtered page/count requests,
their native read work, useful completions and source fallback failures under
mixed traffic. Confirm a resource-limited heartbeat does not renew freshness
and that persistent failures still age out. Keep observing ingestion and mirror
health rather than interpreting fewer native exceptions alone as recovery.

Remaining independent work includes installation-wide native admission and
avoiding the unit-link history scan that remains after removing its duplicate.
The user explicitly superseded the iteration-14 calendar-window policy after
observing its load. Revision/access guards from iterations 12–14 remain in place.

## Reply discovery plans

Read-only `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` probes used the existing
Pivnich relations and indexes, never new remote functions or advisory locks.
An initial lookup spent 59.539 ms with JIT; the migration disables JIT only
inside the component-discovery helper. With JIT off, independent/existing/
largest-thread probes completed in 3.255/5.137/5.154 ms, with 21/142/348 shared
hits and 0/2/11 reads. Relationship/source access used bitmap/index scans;
message, datasource-group and inbox lookups used their indexes. These are
single read-only discovery probes, not write latency or production acceptance.
Sanitized plan summaries are in `measurements.json`; raw plans remain private.
