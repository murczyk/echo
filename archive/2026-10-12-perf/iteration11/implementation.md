# Bounded query follow-up (#3780, 26 October)

Local work on `3780-26oct`, created from `main` at
`4880216abc379475477868b8ad8e786a9bbd865b`. The
[morning findings](findings.md) and [previous evening](../iteration10/findings.md)
record the deployed releases. These application changes are not deployed.

## Changes

The failing global effective-time bounds query belongs to network callsign
activity, in `sigint/network/analytics.rs`. It is distinct from the regular
Analysis stats bounds query, which already reads only the inbox table.
Network activity now finds the requested networks' source ID bounds first,
then evaluates effective time in one-million-ID chunks, explicitly bounding
both joined tables. Empty networks stop before analytics work. Interception
time remains authoritative, followed by message timestamp and creation time;
inclusive and exclusive period endpoints retain their original meanings.

Inbox candidate queries now use ID chunks for broad access-only requests as
well as frequency and unit filters. Each chunk retains ordering, cursor
predicates and the final page merge. The existing recent-window probe remains.
The analytics inbox join is explicitly inner, retaining the prior effective
semantics, and the identical second group-access membership semijoin is removed.
The remaining membership check, denied filters and both tables' ID bounds stay.

Ordinary and historical inbox counts now use the same bounded query builder.
Counts are added across disjoint chunks, first-message timestamps use the
minimum, and historical creation-time cutoffs retain the source fresh-tail
split. A chunk error fails the analytics attempt; partial totals are not
returned. Existing chunk concurrency remains two.

The legacy `/api/sigint/freqs` path previously aggregated all matching locations
before selecting thirty frequencies. It now counts first and loads locations
only for the selected page. Requests without callsign, unit/investigation or
sender filters can count through the existing freshness-checked analytics
fallback mechanism in one-million-ID chunks. Chunk totals are merged before
global sorting and pagination. PostgreSQL orders the narrow merged totals
using the existing database collation; access and selected-group predicates remain
separate, preserving their prior semantics. Recent source messages are counted
separately by creation time, using a tail of at least five minutes or twice the
configured freshness allowance. Historical analytics uses the opposite,
exclusive cutoff, preventing duplicate counts and retaining backdated arrivals.
Unsupported requests and analytics failures retain the source count path.
Frequency metadata, locations and previously-seen status still use PostgreSQL.
Unknown-network filtering is applied on source PostgreSQL to the merged counts
before sorting and pagination, using current source assignments instead of
replicated network metadata. The source fallback also retains that filter
before its page limit.

## Production-scale read-only probes

See [implementation measurements](implementation_measurements.json). Native
page/bounds probes used four threads, a 2-GiB memory cap and eight-second
execution limit. Frequency probes used the configured analytics gateway and
source read-only transactions with an eight-second statement timeout. Query
literals, message IDs, access-group keys and locations are excluded from this
archive.

| Probe | Before | After |
| --- | --- | --- |
| Captured broad native page | Memory exception; 136,755,115 raw rows read | Bounded page chunks replace the full-range query |
| Same four-million-ID page chunk, duplicate access check removed | 913 ms; 168,855,107 bytes; 35,724,412 raw rows | 586 ms; 111,529,270 bytes; 23,878,780 raw rows; same 20 result IDs |
| Captured global effective-time bounds | Memory exception; 2,362,134,748 tracked bytes | One scoped one-million-ID probe: 125 ms; 163,395,168 bytes; 1,674,219 raw rows |
| Frequency counts with locations simply removed | Still exceeded the source eight-second probe limit | Two analytics chunks completed in 1,321 and 1,035 ms including SSH/gateway overhead |
| Locations for the selected thirty frequencies | Previously part of the full-period aggregation | PostgreSQL execution 4,030 ms; 140,558 shared reads; no temporary blocks written |
| Source frequency fresh-tail count | Separate new bounded predicate | PostgreSQL execution 109.5 ms; 64 shared reads; no temporary blocks written |

The original application frequency failures took approximately fifty seconds;
that is an observed timeout, not a completed old-query timing. Source-only
count and forced correlated-lookup prototypes still exceeded eight seconds
and were not adopted as the main fast path. A materialized date-filtered
source bounds probe used the existing datetime/ID index; a direct min/max
version timed out, reinforcing the need to inspect actual plans.

A final hybrid-query probe completed its two history chunks in 1,420 and
1,261 ms including connection overhead. All thirty selected frequency counts
matched an independent source PostgreSQL recount, which completed in 5,315 ms
including connection overhead.

These are individual SQL probes on changing production data. Cache state and
concurrent workload were uncontrolled. The frequency chunks were measured
sequentially, and the recent-tail probe was measured separately. They do not
establish whole-endpoint latency or sustained performance. Native raw-row work
and source page-location work remain material; the aggregate gateway-user
memory cap still applies across concurrent requests.

## Validation and delivery

Validation uses `wd_test_3780_26oct` and `wd_files_test_3780_26oct`, restored from
the standard test dump. Database regressions cover chunk-edge effective-time
fallbacks, inclusive/exclusive periods, access-only inbox pages, count totals,
creation-time fresh-tail splits, sparse frequency IDs, deleted/inaccessible
messages, selected/empty groups, locale-sensitive frequency ordering and
frequency pagination/locations. The
frequency hybrid regression includes an arrival outside the replica ID bounds
at the exact source cutoff, contributing to an existing frequency.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check`, `git diff --check` | Passed |
| `cargo check -p wdintel-rs --all-targets --all-features` | Passed |
| `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings` | Passed |
| `cargo test -p wdintel-rs --bin wdintel-rs 3780 -- --test-threads=1` | 42 passed; one existing ignored test |
| Compiled test binary: `hybrid_inbox --test-threads=1` | 2 passed |
| Compiled test binary: `attachments::tests --test-threads=1` | 20 passed; overlaps the issue-filtered suite |
| Compiled test binary: `sigint::freq::tests --test-threads=1` | 7 passed; includes the new frequency regression |
| `just build-front` | Passed |
| Five #3546 Duty/settings Vitest suites | 82 passed |
| New archive JSON and relative documentation links | Valid |

The related backend suites ran directly from a copy of the same newly built
test binary after the issue-filtered run. This avoided repeated Cargo lock
contention with builds in other local checkouts; database names, log level
and single-threaded test execution were unchanged. No test required a remote
write.

No schema, index, binding generation or analytics configuration change is
required. Deployment remains a separate operation requiring explicit approval.
Use the [production verification checklist](../../../docs/performance/3780-verification.md)
for matched observation windows, later pages, peak load and correctness.
Check `frequency list` routing alongside broad inbox counts/pages and network
activity; monitor source timeouts, native memory errors and total gateway-user
memory. A backend rollback restores the old query paths without a schema
rollback.

The source fallback can still be expensive during analytics failure, and the
remaining tag/facet fallbacks need observation after deployment. This work does
not repair missing AORs, ambiguous units, GOI integration warnings, CBR's archive
listing bug or the external AI provider. The authorized CBR AI pause remains
as documented in the morning findings.
