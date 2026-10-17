# Follow-up investigation for #3780

Evidence collected on **15 October 2026**, mainly 19:56–20:15 UTC, using the
existing SSH agent on Pivnich, Skhid and Siversk. Production operations were
bounded, read-only SELECTs/EXPLAINs and log/config inspection. No deployment,
production migration, tuning, worker restart or data change was performed.
[Measurements](investigation_measurements.json) contain sanitized results;
request arguments, identities, grants and raw plans remain private.

The strongest next changes are the last-seen access path and pathological
network-ID bounds. Creation-time bounds need different treatment: their
covering index already exists, and a parallel aggregate does not consistently
reduce work. Operational warnings have several independent causes.

## Network last-seen: a measured implementation candidate

A matched 555.8-second window, 19:56:26–20:05:42 UTC, showed:

| Host | Completed statement calls | Accumulated execution | Shared-block reads | Pending tasks, start → end | Oldest age, start → end |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pivnich | 31 | 408.7 s | 28.8 GiB | 212 → 218 | 44.6 → 40.0 min |
| Skhid | 39 | 143.8 s | 19.6 GiB | 3 → 5 | 39.9 → 37.0 s |
| Siversk | 0 | 0 | 0 | 0 → 0 | — |

Pivnich removed at least 58 initially observed task IDs and gained at least 64
new IDs still present at the end. These are lower bounds: tasks created and
completed between snapshots are invisible. Oldest age improved, but the queue
did not drain. Neither endpoint snapshot captured a blocked query. This does
not rule out intermittent locks. Execution seconds sum concurrent statements;
block reads are PostgreSQL buffer reads, not confirmed physical device reads.
One Pivnich statement-statistics deallocation limits matched-entry totals.

`sigint/network/recalculation.rs::recalculate_last_seen` joins all network
message links before evaluating `MAX(COALESCE(ii.datetime, sm.timestamp,
sm.created_at))`. The existing `(freq, datetime) INCLUDE(id)` dated index and
partial `(freq,id) WHERE datetime IS NULL` index permit another access path:

1. For each target frequency, seek the latest nonnull inbox datetime within
   both frequency and network active ranges. Check message deletion and network
   membership before `ORDER BY datetime DESC LIMIT 1`.
2. Separately aggregate undated inbox rows with a nonnull message timestamp.
3. Separately aggregate rows with neither date, using message creation time.
4. Take the maximum of these disjoint branches. Preserve a NULL result when
   no activity remains or the network was deleted; preserve target deletion.

The read-only [prototype](last_seen_probe.sql) accepts frequency IDs and a
fixed UTC horizon. It is an investigation artifact, not an application change.
Only the SELECT equivalent of the current UPDATE was executed on production.

| Pivnich case | Target frequencies | Current SELECT | Date/frequency-first SELECT |
| --- | ---: | ---: | ---: |
| Oldest queued network A | 1 | exceeded 8 s | 2.43 ms |
| Oldest queued network B | 2 | exceeded 8 s | 2.40 ms |
| Common network | 1 | exceeded 8 s | 2.19 ms |
| Common network | 4 | exceeded 8 s | 3.50 ms |
| Common network | 16 | exceeded 8 s | 108.03 ms |

These were sequential live-load diagnostics, not randomized capacity tests.
The candidate used 0 temporary writes and 9–822 shared-block reads. A local
10,000-message fixture compared all 76 nondeleted target results across eight
phases: baseline, deletion of prior maxima, membership removal, frequency
reassignment, narrower active ranges, deleted networks, nullable date branches
and deletion of all networks. All **608 result comparisons agreed**, including
NULL/decreasing maxima. This is useful semantic evidence, not proof of
concurrency or worst-case selectivity.

**Follow-up implementation steps:** port the disjoint-branch query into the
existing transaction and batching flow; retain its advisory/parent-row locks,
claimed-task handling and task deletion. Add the comparison cases to the
existing database-backed recalculation suite. Measure sparse/absent membership,
common frequencies with no matching network messages, 100/500-target batches,
and custom/generic prepared plans on a representative restored database.
A descending frequency scan can be poor when membership rejects most rows;
check whether a network-first path remains appropriate for those cases.
Exercise concurrent enqueue, reassignment/deletion and decreasing maxima.
Canary only after that validation, comparing completed tasks, queue age and
reads per task. Retain the current query for rollback. Do not change batch
size, worker count or the 300-second statement/50-second run budgets first.

## Bounds: separate network selectivity from creation-time scans

### Network message-ID bounds

The current `MIN/MAX(message_id) WHERE network_id=ANY($1)` can scan the global
message-ID index and filter network IDs. Its cheap common-network behavior
hid a severe absent-network case. Per-network lateral min/max seeks use the
existing `(network_id,message_id)` index.

| Pivnich case | Current, custom / generic plan | Per-network seeks, custom / generic |
| --- | ---: | ---: |
| One common network | 4.20 / 1.71 ms | 1.26 / 0.28 ms |
| Sixteen common networks | 1.02 / 1.08 ms | 9.98 / 1.70 ms |
| Absent network ID | exceeded 5 s / exceeded 5 s | 0.30 / 0.23 ms |

Cache order was uncontrolled. The absent case deliberately used a nonexistent
ID; it demonstrates the access-path failure, not how often users hit it.
The earlier eight-common-network sample was also slightly slower with seeks.

**Follow-up steps:** implement the endpoint-seek aggregate, or a measured
selectivity-aware alternative, only after testing real new/empty networks,
sparse existing networks, mixed arrays and larger arrays. Require identical
NULL/empty-array behavior and bounds; do not derive bounds from dates or assume
monotonic IDs. Preserve the common-network comparison in review rather than
claiming a universal speedup. Add a fixture for a valid network with no links.
No extra index is justified by this evidence.

### Siversk creation-time bounds

In the matched window, the source creation-bound query ran **789 times**,
consuming **156.8 execution seconds** and **33.3 GiB** of shared-block reads.
Pivnich/Skhid ran it 3,235/1,658 times, consuming 108.8/123.0 seconds.
`signal_message_created_at_id_idx(created_at,id)` already exists on all hosts.
Siversk's index-only scans still required 20,563 / 56,466 / 253,610 heap fetches
for 1 / 8 / 31 days. Table visibility was about 90.5%; recent pages can be much
less visible than the table average. Last observed autovacuum was 13 October;
there were about 104k dead tuples and 53k inserts since vacuum. These counts
alone do not establish an autovacuum fault.

The existing `OFFSET 0` barrier protects against global-ID endpoint scans. A
semantically equivalent aggregate using `FILTER (WHERE TRUE)` allowed parallel
aggregation for the 31-day custom plan: 1,365 → 579 ms with two workers. Its
generic plan stayed serial at 1,364 ms, and its 1/8-day cases were unchanged or
slower. Heap fetches and block work did not materially fall. Increasing query
parallelism is therefore **not an accepted fix** for concurrent load.

The five-second bounds-cache key includes pool, sort, effective dates and
source/analytics choice. `resolve_analytics_inbox_message_id_scope` tightens
those dates using each pagination/tail cursor before looking up the cache.
Different cursors can create different keys even with identical visible date
filters. The Duty request builder inspected here passes explicit dates as
provided; a claim that it always substitutes `Date.now()` would be unsupported.
Actual production key cardinality/hit rates are not logged.

**Follow-up steps:** instrument bounds-cache hits/misses/load time with bounded
labels and aggregate distinct-key estimates; distinguish cursor tightening
from user filters. Compare reusing conservative outer date bounds with exact
cursor bounds on the same request workload. Broader cached bounds must remain
a superset, retain the final date/authorization/cursor predicates, and account
for newly arrived messages during the TTL. Do not extend TTL or introduce
shared result counts. Inspect autovacuum progress/eligibility and visibility
by recent range before any VACUUM tuning. Compare total work and HTTP p95 under
concurrency, not only the faster parallel single-query result.

## Logs and deployment

At 19:58 UTC, a roughly five-minute application-journal sample contained:

| Host | Events | Message bytes | GOI message bytes | GOI candidate / selected row dumps |
| --- | ---: | ---: | ---: | ---: |
| Pivnich | 17,409 | 3.61 MB | 0 in this window | 0 / 0 |
| Skhid | 40,387 | 11.01 MB | 6.68 MB (60.7%) | 2,517 / 2,517 |
| Siversk | 2,405 | 0.41 MB | 0.02 MB | 12 / 12 |

These count MESSAGE bytes, not journal file growth or central ingestion volume.
The short window cannot establish a retention budget. Source inspection of
`organism/goi/callsigns_sync.rs` confirms INFO dumps of each candidate, selected
row and existing workbook row, even when the final workbook is unchanged.
The repository search found no deployed parser depending on those row-dump
strings; external consumers have not been enumerated.

Pivnich explicitly uses `Storage=volatile`, `RuntimeMaxUse=100M`,
`RuntimeKeepFree=50M`, `SystemMaxUse=0`, `SystemKeepFree=0`. Its lack of
`/var/log/journal` is **not merely a missing-directory diagnosis**. Skhid and
Siversk have persistent journal directories and no explicit settings in the
inspected merged configuration. Root free space was approximately 107/342/254
GB. Earlier retained Pivnich history was only about 16 minutes.

The actual shipper is **`echo-vector.service`**, using **`/etc/echo/vector.yaml`**;
`/etc/vector/vector.yaml` is an unrelated default. On all three hosts the live
process enables the SigNoz sink and has an endpoint, but its journald source
uses `since_now: true`, and no disk buffer is configured. No shipper journal
errors appeared in the sampled 30 minutes. Central receipt freshness could
not be verified: the unlocked SSH identity was rejected for both `echo` and
`ubuntu` on the configured receiver. Enabled configuration and quiet service
logs do not prove successful delivery or replay after restart.

**Follow-up steps:** keep INFO sync totals/diff counts, duration and failures;
move individual GOI row dumps to opt-in DEBUG, preserving a way to diagnose a
specific sync. Check external consumers first. Verify central latest timestamps
per host/unit through an authorized telemetry connection. Then test a shipper
restart/outage with replay and bounded disk buffering in staging. Give Pivnich
a reviewed persistent retention budget using measured journal growth and a
specified incident-history target; update the explicit volatile configuration,
not just the directory. No production log settings were changed here.

The `justfile` deployment recipe stops/masks the API socket/services **before**
`apt-get update` (600-second allowance) and package installation/download
(1,200 seconds), then migrations/reconciliation and readiness. The Redis
maintenance marker lasts only **120 seconds**, once, and emits wake events.
It does not keep the upstream socket available, and can expire during those
phases. Historical connection-refused bursts are consistent with this sequence.
The cleanup trap does unmask/restart enabled services; failure recovery is not
absent, but needs to preserve schema/package compatibility.

**Follow-up steps:** stage package metadata/download and preflight while the
old service is healthy; enter maintenance only for install/migrate/start.
Reconcile the maintenance lifetime with actual deployment duration and failure
cleanup. Provide a bounded proxy maintenance response while the API socket is
unavailable, including Retry-After and the existing client protocol. Test
package-download, dpkg, migration, startup and readiness failures plus older
clients in an isolated installation. No deployment was run to test this on
production.

## Oversized upstream headers

Retained 15 October nginx errors attribute **17** failures to `/api/user/logout`
(Pivnich 1, Skhid 14, Siversk 2), and one Skhid failure to `/api/delta-redirect`.
Every logout error line is exactly **2,048 bytes** and lacks the end of its
request field: nginx truncated the URL. An apparent 1.8k URL/Location estimate
from those lines is therefore invalid. The OAuth callback line is complete,
but its short request URL says nothing about its returned redirect.

No `proxy_buffer_size`/`proxy_buffers` override appeared in the live nginx
configuration; system pages are 4 KiB. Existing large client-header buffers
operate on incoming headers, so they do not address these upstream responses.
`user_logout` form-encodes its redirect into a login Location; local-target
validation prevents unsafe origins/login loops but places no length limit on
a large application filter URL. This is a plausible cause; the full returned
header set was not captured, and production logout/OAuth was not invoked.

**Follow-up steps:** reproduce logout and OAuth completion locally with a large
synthetic Analysis filter URL through the real session middleware and nginx.
Measure the entire serialized response-header block, including cookies and
Location, below/above the buffer boundary and with Ukrainian/percent-encoded
filters. Keep the destination through a short server-side reference or another
measured bounded representation if this is the cause. Select any response
buffer change from measured sizes; retain open-redirect validation. Do not
silently discard filter state or raise request-header buffers as the fix.

## OCR: distinguish the expensive queue read from rejected grants

`ocr/mod.rs::load_queue_positions` ranks and returns the whole active queue,
including eligible undiscovered media, when a caller needs positions for a
small visible set. In the matched window it ran 62/79/5 times, consuming
19.6/49.4/0.24 execution seconds on Pivnich/Skhid/Siversk. Source queues contained
25,289/41,295/621 queued jobs, versus 2/2/1 currently submitted jobs. This is a
separate cost from grant validation.

The gateway grant is issued by `ocr/worker.rs::dynamic_manifest` **at extractor
submission**, with a **15-minute** expiry. Source queued jobs have no submitted
manifest yet: their source-queue waiting time does not consume the grant TTL.
The grant binds media, engine, instance and job-generation timestamp. A single
user-facing rejection also covers bad signatures, versions/expiry, instance
mismatch, changed/missing job generation or state, and a disabled engine.
Web/background-worker signing keys matched on all three hosts at inspection;
the report worker's lack of that key is irrelevant to this issuing path.

No currently submitted job was older than 15 minutes. Historical completed
submission durations reached 2,063 / 2,814 / 2,063 seconds. Those runtimes make
expiry plausible, but do not show when the last gateway call occurred. No
stored job `last_error` contained a grant error; the previously observed 110
Skhid warnings cannot be assigned a rejection reason from the retained data.
The earlier proposal to reproduce this with a long-open user tab was incorrect:
this credential belongs to an extractor job, not that tab.

**Follow-up steps:** add nonsecret internal rejection reason codes and correlate
job generation, grant age, extractor queue/start/callback time and job state.
Do not log tokens, keys or OCR content. Reproduce delayed extractor pickup,
expiry during multi-page work, retry/reprocess generation changes and key
rotation. Choose refresh/reissue/TTL semantics only after measuring that path.
For queue positions, benchmark returning only requested positions while ranking
the full eligible relation, and a separately maintained queue snapshot if
needed. Filtering requested IDs before the window function would change ranks.
Do not fix grant failures by extending every token's lifetime blindly.

## Repeated text-search notices and settlement locks

The retained approximately 30-minute application scan found **59,224** empty-
lexeme/stopword notices on Skhid and **1,968** on Pivnich (whose journal retains
less history). SQLx maps PostgreSQL NOTICE to INFO. Production records do not
include the originating search argument, so individual callers remain
unattributed.

`attachments/search.rs::term_tsquery` embeds both Russian `plainto_tsquery` and
prefix `to_tsquery`. A local generic-plan sequential scan of 1,000 synthetic
vectors with the stopword `на` emitted **2,000 notices** and took 5.98 ms.
The equivalent scalar initplan parsed once, emitted **2 notices**, and took
0.082 ms. This reproduces a concrete repeated-parse mechanism; it does not
prove every production notice came from this function.

**Follow-up steps:** record sanitized query shape/route and bounded notice
counts to attribute the live pattern. Compare parsing each request term once
using an initplan or an equivalent parameterized representation. Preserve
empty-lexeme, stopword, prefix, numeric/filename, OR and negative semantics,
Exact/Substring modes, GIN use and complete gateway pushdown. An initplan that
forces local FDW aggregation would undo the earlier performance fixes.
Do not suppress PostgreSQL notices globally as the first change.

The new snapshots did not identify historical settlement/battle-line blockers.
One retained Skhid advisory-lock entry was a slow statement, not evidence of
which transaction blocked it. Earlier source logs establish lock timeouts, but
not their owners. `battle_line::lock_updates` takes a blocking exclusive
transaction advisory lock; the settlement worker refreshes its catalog under
that lock. Resolution now commits item updates before queuing stats, so the
old stats-enqueue lock theory must not be reapplied without checking the
current code. Repeated incorrect-mapping warnings also describe data ambiguity,
not automatically lock failures.

**Follow-up steps:** capture blocked PID and `pg_blocking_pids`, blocker age,
transaction/query identity and lock namespace at the warning, with a short
bounded sampler during a recurrence. Include catalog refresh, battle-line
upload/reconciliation, location/AOR changes and settlement resolution. Resolve
lock order/scope only from a captured dependency chain; distinguish invalid
mapping data in separate counters. No timeout increase or warning suppression
is justified yet.

## Recurring Duty requests

A separate activity-store query for 19:56–20:05 UTC counted distinct request
IDs, classifying pages from the retained referer and combining each host's
internal/public names:

| Host | All count requests | Duty Classic | Duty Neo | Analysis | Unknown/other | Long polls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pivnich | 13,170 | 6,137 | 6,487 | 152 | 394 | 27,601 |
| Skhid | 11,428 | 4,186 | 2,856 | 527 | 3,859 | 28,618 |
| Siversk | 2,680 | 1,037 | 1,447 | 70 | 126 | 11,637 |

This identifies substantial Duty traffic, including on Siversk, without proving
a polling defect per tab. The deployed activity context allowlist records
referer/basic HTTP headers but no dedicated frontend release, tab identity,
visibility or request-trigger fields. Unknown referers cannot be assigned to
Duty safely. The current frontend request code has per-feed in-flight guards;
those do not establish the behavior of every deployed classic/Neo tab.

**Follow-up steps:** record bounded release/visibility/trigger diagnostics and
an ephemeral tab correlation identifier without exposing credentials or filter
contents. Measure requests per active/hidden tab and refresh trigger before
changing scheduling. Preserve count scopes, discovery, unread state,
notifications and creation-time ordering. Keep Analysis's previously deployed
polling change separate in the comparison. Host totals do not justify new
shared count caching.

## Cancellation and analytics limits

A local diagnostic against the project's **SQLx 0.9.0** pool dropped a
`pg_sleep(2)` request at 100 ms. At 300 ms the PostgreSQL backend was still
active in `PgSleep`, and the one-connection pool could not supply a connection.
It recovered at **2,000 ms** without a server timeout, and **1,079 ms** with a
one-second statement timeout. Dropping the future bounds the caller, but does
not demonstrate immediate cancellation of submitted SQL. The approved HTTP
timer still removes queued application waiters; it does not solve this second
resource-lifetime problem.

**Follow-up steps:** validate explicit cancellation on dedicated checked-out
connections, timeout scoping/reset and pool reuse after cancellation locally,
then verify the complete gateway → ClickHouse cancellation path in staging.
Avoid a late cancellation reaching an unrelated pooled request. Capture native
query IDs and confirm server work stops when the HTTP deadline expires.
Keep server statement limits until that is proven.

The earlier AOR/sender probes fit inside a 2-GiB diagnostic cap, while other
supported production queries reached 6.89 GiB under a 17.60-GiB server ceiling.
This investigation did not run a concurrent production replay. A universal
2-GiB cap, more threads, higher memory ceilings or extra fallback slots remain
unsupported. Replay representative ordinary/heavy requests plus CDC/merges on
a representative restored analytics dataset, then choose a persistent
gateway-only profile and rollback from useful throughput, p95/p99, memory/RSS,
cancellation and maintenance headroom. Preserve distinct users' count scopes;
no new cross-user count sharing is proposed.
