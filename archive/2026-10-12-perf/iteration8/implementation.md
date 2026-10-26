# Skhid follow-up fixes (#3780)

Local work on `3780-skhid-followup`, based on `origin/main` at `478956874`.
The [deployment observations](findings.md) describe the already running release;
the changes below have not been deployed by this work.

## Investigation and changes

All **102** sampled `attachment_search_coverage` rejections were
`recent_message_change`, despite complete historical attachment coverage.
The shared route label `attachment_history_incomplete` includes these typed
guard failures; it does not mean the historical copy is missing. The guard
and its source/analytics membership checks remain necessary for fresh edits,
moves, deletions and negative searches. No coverage flag, ledger, freshness
window, admission limit or retry state was changed.

A captured source fresh-tail count used an uncorrelated search-term UNION over
body, filename and attachment matches. Its outer creation-time lower bound
could not stop that global text work. Inside bounded read-only probes with an
eight-second statement limit, the original count took **5,501 ms** with
193,144 shared hits and 41,853 reads. The equivalent candidate-correlated
predicate took **71.8 ms**, with 2,308 hits and 540 reads. Neither spilled
temporary blocks. A separate read-only repeatable-read comparison returned
identical counts and first-message timestamps. Cache and concurrent work were
uncontrolled; shared-block reads do not establish physical disk I/O.

Fresh-tail pages and all three count construction paths now correlate search
terms to the outer message ID, retaining scalar tsquery parsing on PostgreSQL.
This includes ordinary unit-period filters and direct unit-ID filters.
Structured frequency/UID terms, search modes, filenames, attachments,
authorization, cursor boundaries and full-period source strategy are retained.

Unbounded latest pages previously selected candidates from every historical
ID range, even when recent traffic could fill the page. The application now
first requests the last two days by creation time, with the lower boundary
rounded down to a minute for ID-bounds cache sharing. A full 20-ID page can
stop there: excluded creation times are older than every returned candidate.
If the probe is sparse or empty, the existing full-history query still runs.
Explicit date/cursor requests and unlimited reads bypass this optimization.
Deleted/inaccessible messages, equal creation-time ordering and source fresh
tail merging retain their existing handling.

A read-only diagnostic of a captured native unit-filtered latest-page shape,
with the recent creation predicate and matching ID lower bounds, returned a
full page in **1,894 ms**, tracking **174,948,273 bytes** and reading
**95,422,939 raw rows**. Source recent-ID bound planning took **569.7 ms** in
its actual plan. Native diagnostics used four threads, a 2-GiB cap and an
eight-second limit. This was a SQL prototype on changing live data, not the
new backend serving the captured 17.4-second request. The remaining raw-row
work is substantial; no controlled endpoint speedup or peak-load SLA is claimed.

## Validation and delivery

Review validation used the dedicated `wd_test_3780_branch_review` and
`wd_files_test_3780_branch_review` databases, with the source restored from
the standard test dump. The existing pagination regression now compares
fresh-tail IDs/counts across all three ordering bases and cursor directions.
The latest-page regression covers dense, sparse and empty recent windows,
creation-time ties, old interception dates, deleted/inaccessible messages and
the original unlimited behavior. A database-backed search regression compares
body/filename, negative, OR, quoted and structured-frequency searches in all
three modes with and without ordinary/direct-ID unit filters. It also checks
current attachment chunks, excludes stale revisions, and verifies combined and
denied unit filters against explicit expected matches through both indexed and
ordinary digest queries.

The latest-page reconciliation regression snapshots a lagged replica, merges a
backdated source arrival, rejects deleted or inaccessible replica candidates,
and verifies that source fallback fills the page. A separate latest-probe
regression preserves positive/negative attachment-change fallback before and
after change-ledger reconciliation, including membership visible only in the
replica and all three requested ordering bases.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` and `git diff --check` | Passed |
| `cargo check -p wdintel-rs --all-targets --all-features` | Passed |
| `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings` | Passed |
| `cargo test -p wdintel-rs --bin wdintel-rs 3780 -- --test-threads=1` | 36 passed; one existing ignored test |
| `cargo test -p wdintel-rs --bin wdintel-rs hybrid_inbox -- --test-threads=1` | 2 passed |
| `cargo test -p wdintel-rs --bin wdintel-rs attachments::tests -- --test-threads=1` | 20 passed; overlaps the issue-filtered suite |
| `just build-front` | Passed |
| Five #3546 Duty/settings Vitest suites | 81 passed |
| New documentation's relative links | Resolved |

No migration, model/binding generation, data repair, gateway setting change,
history copy or resnapshot is needed. Deliver through the ordinary separately
approved application deployment. Follow the
[production checklist](../../../docs/performance/3780-verification.md) for
matched windows, a 30–60-minute canary and a later peak period. Pay particular
attention to sparse-probe overhead, source bounds-query work, full-period
quoted/Exact/Substring search, broad native unit counts and attachment fallback
frequency. A backend rollback restores the previous query paths without a
schema or analytics-data rollback.
