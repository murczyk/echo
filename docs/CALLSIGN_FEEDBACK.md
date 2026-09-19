# Callsign parsing feedback

Issue: [#3167](https://github.com/echoua/echo/issues/3167).

Successful user removals from React analysis cards and the Elm message editor
record an immutable message snapshot, actor, callsign and action UUID. Cancelling
an edit records nothing. Request retries and duplicate-message propagation count
once. Generic synchronization and catalogue/network deletion are not feedback.
Historical deletions are not backfilled into the feedback count.

The parser combines non-AI template/metadata results with AI results, adds explicit
manual inclusions, then applies message-specific manual exclusions. A later manual
addition supersedes that message's exclusion; the historical removal count remains.
Existing creator/deleter attribution conservatively protects older manual edits;
it cannot reconstruct historical remove/re-add sequences whose attribution was lost.

The first AI call uses the configured prompt. If any candidate has feedback, one
additional call to the same engine receives the current message, candidate counts,
and up to three distinct recent excerpts per candidate. Excerpts are centered near
the candidate, limited to 1,000 characters each and 6,000 characters overall, with
the budget shared across candidates. Input is capped at 24,000 characters, including
the system prompt. Examples are discarded before rejecting an oversized current
message. Feedback is contextual evidence, not an unconditional blacklist. New
second-stage candidates are checked against current-message highlights so names
cannot simply be copied out of historical examples.

Failures preserve existing callsigns and use the existing eight-attempt exponential
backoff. Template results remain independent of AI approval. Explicit user removals
also survive ordinary non-AI message reprocessing.

## Worker and administration

`wdintel-rs-bgworker` owns normal parsing and historical cleanup. A dedicated
PostgreSQL advisory-lock connection, checked every five seconds, prevents multiple
processes from owning these loops. Losing that connection cancels in-flight work.
Normal jobs and cleanup are interleaved, with a normal job attempted first, avoiding
starvation of either queue. Network requests run outside row-locking transactions.
Completion rechecks the body and overrides under locks; stale work cannot overwrite
user edits. A new enqueue advances the existing job timestamp monotonically so an
older request cannot delete or retry-update newer queued work.

While the callsign worker is enabled, new feedback starts an automatic run no more
than hourly. Its fixed UTC window is the preceding 14 days of inbox `datetime`.
Manual runs use all historical feedback and any positive whole-day window whose
timestamp is representable. Reviewed messages are included. Matching uses active
normalized callsign associations, not a text scan over messages.

The admin AI callsigns page has a feedback tab, paginated evidence, current-message
previews, manual launch, cancellation, retry, counts, rate and estimated remaining
work. A second launch returns the active run. Cancellation leaves pending work
resumable. Failed items remain available for inspection and retry.

Each run snapshots per-callsign feedback counts transactionally. Later feedback
remains pending, independent of sequence allocation or commit order. Enumeration
uses keyset batches of 1,000 candidate message IDs, then filters their timestamps
and deduplicates jobs. The cursor advances even when a batch has no window matches. Completion and progress
counters commit together. After a run finishes, successful/skipped job details are
removed in 1,000-row batches; compact run totals and failed jobs remain. Cancelled
runs retain their resumable work.

## Storage and deployment

The migration creates seven initially empty operational tables: removal events,
per-callsign counters, per-message overrides, action deduplication, run summaries,
run targets, and queued message jobs. It does not alter or backfill the large inbox,
message, or callsign tables. All seven tables are excluded from analytics replication;
normal deployment synchronizes exclusions before migrations. No mirror resync is
required. Existing worker enablement and engine selection control the feature.

Feedback bodies are stored only for actual removals, never for every parsed message
or every re-parsing job. Jobs contain IDs and status, not copies of message bodies. Foreign keys back to
messages have supporting indexes so deletion does not scan all events or actions.
Only issue-supplied and synthetic evaluation fixtures are checked in; no restored
message corpus or engine credentials are included in this repository.

## Production-scale evidence (2026-09-06)

Read-only queries were run against the nightly Pivnich development restore and
Kharkiv's ClickHouse data through its PostgreSQL analytics gateway. No schemas or
application data were changed remotely. Direct SSH authentication to Kharkiv's
application development host was unavailable.

| Measurement | Pivnich restore | Kharkiv analytics |
| --- | ---: | ---: |
| Callsign association rows | 21,282,651 | 6,926,165 |
| Messages in approximately the preceding 14 days | 796,337 | 84,305 |
| Database size | 147 GB | Not measured |
| Callsign relation including indexes | 7,856 MB | Not measured |

The Pivnich `SYSTEM (0.1)` message sample contained 20,661 rows. Average body size
was 553 bytes, median 430, and p99 2,367. The supplied negative names matched 4,764
recent message/callsign associations (before deduplicating messages), under 0.6% of
the full recent-message population. Each selected message needs at most two AI calls;
no feedback match adds no second AI call.

`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` exposed an expensive
historical-prefix scan when limiting only final date matches. For `красавчик`, the
first 100 matches cost 735.488 ms (4,486 candidate rows), versus 12.497 ms on the
next page. A more common `байкал` took 4,148.973 ms and 166,262 inbox lookups before
finding 100 recent matches. These measurements ruled out an unbounded date-filtered
page query.

The final query materializes at most 1,000 candidate IDs from the existing active
callsign index before joining inbox timestamps. On the same `байкал` restore it
used exactly 1,000 indexed inbox lookups, 3,046 shared hits and 974 reads, in
60.184 ms. The callsign/ID cursor was an `Index Cond`. Old prefixes still require
multiple batches, but each batch releases its locks and yields to normal parsing.
No extra large-table index or timestamp duplication is needed.

A local transactional sizing experiment created an equivalent temporary feedback
table and inserted 100,000 synthetic 553-byte bodies across 10,000 callsigns:
65 MB of rows plus 14 MB of indexes, 79 MB total before the small message-FK
lookup index added during final review. This is an estimate for removal
events only, not a projection of all parsed messages. A bounded example lookup used
the callsign/ID index and took 0.072 ms. The transaction was rolled back. Actual
storage depends on body distribution and future removal volume.

Monitor removal volume, active-run throughput, retained failures, first-page query
latency, worker errors and inference traffic. If cleanup load is excessive, cancel
its run or disable the existing callsign worker; both actions retain feedback.

The live vLLM fixture check passed all five issue/synthetic examples after prompt
refinement, including rejection of ФИПКА in a matching negative context and retention
of an explicitly identifying Аллигатор. See the reproducible
[evaluation fixtures](../ai-eval/2026-09-06-callsign-feedback/README.md); this is a
small regression sample, not a corpus-wide accuracy estimate.
