# Local source-read fixes (#3780)

Prepared on 26 October 2026 after the [Skhid investigation](findings.md).
No deployment or remote repair was performed. Source diagnostics used only
read-only SQL with statement/lock deadlines; no history guard, index, mirror,
configuration or application data was changed remotely.

## Changes

- Combine pure positive Fuzzy OR terms into one match union across body,
  filenames, current attachment chunks and audio filenames. Preserve mixed
  AND/negative alternatives. For finite periods up to seven days with OR terms
  and excluded quoted phrases, materialize eligible date/access IDs, compute
  positive matches, then apply exclusions to that smaller set. Disable JIT
  only within this strategy's read-only transaction.
- Start date-bounded interception-time source candidate/map queries from inbox
  dates. Keep access and map peleng checks correlated to these candidates.
  Creation-time, unbounded and analytics strategies retain their existing
  shapes. Correct the source network facet's literal membership key to the
  obligatory inbox relation, allowing the existing body GIN/index bitmap OR.
- Bound wrapped interactive source SQL to eight queries per API process and
  two per authenticated login. Apply the existing fallback-operation limit
  to query-policy routes too, with two operations per login. Key count queues
  by operation and bound their waits. Keep freshness and revision guards.
- Pin source connections until completion or cancellation. An abandoned read
  uses a separate control connection to cancel only the same backend PID/start
  time and user, then discards its checked-out connection. Retain SQL permits
  during cleanup; bound cancellation and close separately to three seconds.
  Preserve the page selection/hydration repeatable-read snapshot.
- Put activity recording outside the read deadline and record the actual
  error status once. Correlate queue, admission, SQL, fallback and deadline
  stages with the activity request ID. Cancellation logs distinguish a sent
  signal from a failed attempt; they do not assert server completion.

Operational behavior and verification are maintained in
[search routing](../../../docs/performance/3780-search.md#source-search-and-cancellation)
and the [verification checklist](../../../docs/performance/3780-verification.md).

## Production-scale read-only evidence

Sanitized values are in [implementation_measurements.json](implementation_measurements.json).
SQL, actual terms, access keys, request IDs and execution plans remain private.
These are isolated SQL diagnostics on a changing installation, not HTTP
benchmarks, a concurrency replay or acceptance of a rollout.

For the twelve-OR/four-exclusion search family, the diagnostic used the captured
search/period and a separately captured permitted-group scope. The actual POST
authorization/filter payload is unavailable. The old shape exceeded an
eight-second budget. Combining OR sources completed in 5,747 ms, with 124,040
shared block reads. Staging positive matches before exclusions completed in
2,949 ms with JIT enabled and 1,783 ms with transaction-local JIT disabled,
with 8,106 and 5,199 shared block reads respectively. Each completed variant
returned 242 qualifying IDs in its own statement. JIT-off on the broad
unscoped variant exceeded eight seconds, so it is not applied globally.

A same-statement old/revised set-difference comparison exceeded a separate
20-second budget. Equal counts from separate probes are not proof of production
set equality. Database-backed regressions provide the semantic checks, including
current/stale revisions, negative phrases, audio, access and optional inboxes.
Skhid does not yet have the current checkout's audio-search relation: diagnostic
OR comparisons consistently omitted that arm on both sides. Local tests retain
it. No relation was created on Skhid for testing.

The captured map query, rewritten with the same bounded inbox/lateral/access/
peleng strategy, completed in 2,054 ms, returned 49 grouped rows, read 7,042
shared blocks and wrote no temporary blocks. The original statement had timed
out in the incident; it was not replayed unbounded for a paired baseline.

The Exact network membership correction enabled the existing body GIN bitmap
OR and reduced estimated cost from 6.54 million to approximately 29 thousand.
Both original eight-second diagnostic budgets were exceeded. With a separate
20-second budget, one corrected captured statement completed in 8,537 ms,
while the other still timed out. Word-boundary regex spelling experiments also
exceeded eight seconds and were not adopted. This change fixes the missed
index path; it does not resolve broad six-month common-word Exact cost or
establish an end-to-end SLA. Keep #3780 open through approved canary testing.

## Validation and rollout

Database regressions ran against dedicated source/file databases restored from
the standard test dump. The #3780 selection passed 49 active tests; its existing
250k-row attachment-claim benchmark remained ignored. The related analysis
selection passed 51 tests, attachment selection 20, and inbox selection 66. The
inbox run initially lacked the local NLP service; starting the existing Python
service made its submission test and the complete rerun pass. That temporary
local service was stopped afterward. No remote dependency was changed.

The final source version passed the #3780 selection again, including all four
source-driver cancellation/fairness/setting-cleanup tests. The following checks
also passed:

```bash
cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings
cargo check -p wdintel-rs --all-targets --all-features
cargo fmt --all -- --check
just build-front
git diff --check
```

No browser regression or concurrent HTTP replay was performed. The unchanged
third-party `proc-macro-error2` dependency emits a future-incompatibility notice;
strict Clippy reports no warnings in the checked code.

The focused suite protects mixed-source result semantics, permissions,
pagination/count/facet agreement, real PostgreSQL cancellation and pool reuse,
per-login fairness, transaction-local setting cleanup and actual retained
deadline responses. Use the ordinary independently approved deployment path
for any canary; this work does not authorize installing a package, restarting
services, changing analytics metadata or applying unrelated pending migrations.
No schema migration is introduced by this fix. Deployment of the current
checkout must still account for its other changes since the installed release.

After an approved deployment, compare useful completions, queue wait/503 rates,
active source work after HTTP expiry and replication/ingestion over comparable
multi-user windows. Revert the backend through an independently approved
rollback if results or source load regress. There is no new schema to undo.
