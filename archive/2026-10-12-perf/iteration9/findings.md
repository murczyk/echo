# Pivnich verification and source-search fixes — 25 October 2026

## Deployment identity and verdict

Read-only checks from 17:40 through 19:06 UTC found `echo-pivnich` still running
`0.1.1~rc.202610230946-1`. The API started at 07:21:29 UTC on October 25; the
background worker started on October 23. Package logs showed no newer install.
The paired analytics host also lacked the gateway-limit reconciliation script
and gateway-user limits delivered by the recent fixes. Consequently these
measurements cannot establish whether the newly announced deployment improved
Pivnich. Confirm the intended host and installed revision before comparing a
post-deployment window. No environment changes were made by this investigation.

Branch `3780-pivnich-stabilization` was cut from main at `49f50f4c7`.

## Observed traffic

Greptime response events were deduplicated by request ID across the Tailscale
and public Pivnich hostnames. Both windows below served the old release.
Intentional event-stream polling is excluded from interactive route percentiles.
Traffic/filter mix is observational, so the windows do not establish causality.

| UTC window | All responses | HTTP 503 | Inbox-count 503 / calls | Count p95 | Page p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 16:50–17:05 | 91,499 | 85 | 38 / 11,267 | 495 ms | 912 ms |
| 17:25–17:40 | 88,723 | 196 | 95 / 10,950 | 750 ms | 3,031 ms |

The later window included 15 inbox-page 503s and 30-second group, sender and tag
timeouts. Recorded source query-policy errors included 15 inbox counts and
eight errors for each of those three facets. The earlier journal window had
already expired and must not be treated as error-free.

Native completed-query p95 increased from 618 to 801 ms. Peak tracked query
memory reached 4.69 GiB without the newer per-query/user limits. Recent native
exceptions included client cancellations (735) and one socket reset (210),
which are not evidence of total-server memory exhaustion. Captured fuzzy
gateway initplans and insufficiently scoped unit joins match fixes already in
main; this branch does not duplicate those fixes. Health/coverage rows were
fresh and healthy, historical attachment coverage was complete, and the source
replication slot was active. These samples do not establish sustained health.

## Confirmed source-search costs and local changes

A captured source count used one frequency, 29 allowed groups and a 16-day
interception-time scope. Global body/filename/chunk text matches scanned far
more history than the outer frequency/date candidates. Bounded, read-only
PostgreSQL plans compared that shape with per-candidate text checks:

| Scope | Original | Correlated prototype |
| --- | ---: | ---: |
| 1 day | 4,059 ms | 24 ms |
| 7 days | 3,465 ms | 192 ms |
| 8 days | 4,963 ms | 161 ms |
| 16 days | 4,462 ms | 244 ms |
| 31 days | 5,476 ms | 348 ms |

The 16-day shared-buffer reads fell from 262,402 to 3,025, without temporary
writes. A separate same-statement comparison confirmed equal counts and oldest
timestamps. A broad one-day variant improved only from 4,642 to 3,433 ms and
performed many more buffer hits than the selective variant. Correlation is
therefore enabled for one selected nonempty frequency, alongside the existing
analytics/hydration/fresh-tail cases. Other broad scopes retain match-set
planning. Frequency facets still discard their own selected-frequency filter.
These are isolated diagnostic measurements on the old deployment; the final
release also includes audio-filename search and needs end-to-end validation.

Exact/substring source timeouts had a separate cause: no trigram index existed
on `coalesce(body_noheader->>'body','')`, and a body OR nested attachment
predicate prevented useful independent match planning. Both the original
literal prototype and a materialized-candidate rewrite exceeded an eight-second
production diagnostic budget; the unproven materialization was discarded.

On an isolated PostgreSQL 14 fixture with one million messages, 50,000 media
rows and 50,000 chunks, a simple exact-body scan fell from 483 to 36 ms after
adding the expression index. With that index present, the original combined
query initially took 3,133 ms; separate global body/attachment match sets took
50 ms for the same 549 matching messages. Expanded checks rejected that shape:
a very common term slowed from 736 to 2,171 ms and spilled 4,062 temporary
blocks. A direct body predicate with independent attachment EXISTS checks also
exceeded the eight-second production diagnostic budget.

The final shape keeps the body predicate directly on the inbox relation and
collects only distinct attachment IDs into an array. This permits a body-GIN OR
primary-key bitmap path for rare terms and a scoped scan for common terms.
Expression statistics must be refreshed after index creation; without them a
common-term fixture chose the wrong bitmap path. Final warm local comparisons
after `ANALYZE`, with unchanged scopes and no temporary writes, were:

| Literal case | Original | Revised |
| --- | ---: | ---: |
| Exact rare word | 708 ms | 53 ms |
| Exact common word | 746 ms | 217 ms |
| Exact short word | 615 ms | 176 ms |
| Exact negative word | 744 ms | 208 ms |
| Substring rare | 971 ms | 54 ms |
| Substring common | 1,185 ms | 766 ms |
| Substring one character | 2,121 ms | 652 ms |

A prepared common-term query took 2,043 ms with a forced generic plan versus
233 ms with a custom plan (planning 1.82 versus 2.41 ms). Web source/replica
pools now request custom plans, preserving runtime timeout options in one
connection mapper. Worker/operator/file-registry plan policy remains unchanged.
This adds planning work to web source queries and needs CPU validation under
normal and peak traffic.

The production attachment-only match subquery using existing filename/chunk
indexes took 29 ms. The final combined body plan still needs verification after
the new index is deployed. These are isolated and synthetic measurements, not
Pivnich latency guarantees. The synthetic body heap was 601 MiB and the index
165 MiB; its size ratio is not a production sizing estimate.

Migration `m20261025_180900_inbox_body_literal_index` builds the source GIN index
concurrently and refreshes expression statistics. It can resume when a valid
index exists, while rejecting invalid concurrent builds. Literal attachment
matches use independent queries, retaining candidate checks for selective reads,
revision guards, negation and empty/null-body behavior. Creation-time/unbounded
reads use message IDs when the inbox row is optional. The migration declares no
analytics schema change and requires no resnapshot. Pivnich's sampled source inbox had about
20.2 million rows, a 24-GiB heap and 30-GiB total relation size; filesystem space
was 91 GiB free out of 400 GiB. The same catalog sampled 1.91 million media,
162,796 document and 29,705 chunk rows. The attachment-ID array is independent
of body match volume but still grows with matching media/audio rows; inspect
its size and concurrent backend memory as that corpus grows. Recheck headroom
and workload before approving the actual build. New writes maintain the index,
adding ongoing write/WAL cost.

## Worker errors and configuration findings

Repeated media-summary failures reported a lost lease before completion.
Attachment publication explicitly deletes legacy summary jobs, and reprocessing
can replace a running job. The older error lacks a media ID, preventing exact
correlation of each observed event with its invalidation. This branch treats
zero-row guarded completion/retry updates as superseded work, records an
observable superseded attempt, and retains the lease guard against stale writes.
It skips legacy claims for media with a published attachment revision.

Eight distinct groups emitted missing-AOR warnings in a later 15-minute sample.
This requires the owning administrator to choose the correct assignments;
automatic assignment would change access policy. No assignments, retries,
analytics configuration or service state were changed. Heartbeat client-shutdown
messages were also observed; follow existing metadata freshness rather than
interpreting a transient client message as a replication outage.

## Validation and follow-up

The focused database regression covers pages/counts/group and sender facets,
Fuzzy/Exact/Substring, positive/negative/quoted matches, current/stale attachment
revisions, selected frequencies, group/date exclusions and deleted rows across
1-, 7-, 8-, 16- and 31-day scopes. The worker regression covers requeued jobs,
current completion, published-document claim exclusion and deleted jobs without
resurrecting or overwriting obsolete work.

Local validation passed: 38 #3780 regressions (one optional test ignored), two
runtime-pool integration checks, `cargo check`, strict all-target/all-feature
Clippy, Rust formatting, frontend build and the catalog-aware migration check
against main on a fresh standard-dump database. The concurrent-index migration
also rolled back locally and resumed successfully against an already-created
valid index; final `indisvalid` and `indisready` were both true. No entity columns
changed. Incremental compilation was disabled for final Rust validation after a
compiler cache verification failure.

Use the [production verification checklist](../../../docs/performance/3780-verification.md)
after an approved deployment. Confirm the package and analytics bundle first,
index readiness next, then compare matched 15-minute and peak-load windows,
source/analytics result equality, route-specific tails, PostgreSQL deltas,
replication lag and ingestion progress. Broad literal patterns and index write
cost remain production acceptance checks. Neither local tests nor one fast
query closes #3780.
