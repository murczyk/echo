# Pivnich performance follow-up and Skhid recovery (#3780)

Read-only inspection on **23 October 2026**, following
[iteration 5](../iteration5/findings.md). All times are UTC. SSH reused the
unlocked session. Production application code, data, schema, services and
configuration were not changed by this investigation. Retained evidence is in
[measurements.json](measurements.json); raw SQL, parameters and logs remain
private. The subsequent local fixes are described in [implementation.md](implementation.md).

## Improvement since the prior investigation

Both sources served package `0.1.1~rc.202610230946-1`. Pivnich's API started at
10:19:37, with no systemd restarts at inspection. The source migrations for
duplicate lookup and scoped attachment freshness were present; attachment
history coverage was complete on both gateways.

The same host-scoped HTTP response window, **12:30–12:55**, was queried for
15 and 23 October. Counts deduplicate response lifecycle records by request ID.

| Measurement | Pivnich, October 15 → 23 | Skhid, October 15 → 23 |
| --- | ---: | ---: |
| Retained HTTP responses | 193,576 → 194,175 | 187,560 → 122,511 |
| HTTP 503 responses | 188 → 9 | 74 → 310 |

Pivnich's 503 count fell 95% at almost identical aggregate traffic. Its group
facet p95 fell from 30,010 to 8,170 ms, but inbox-count p95 increased from 361
to 624 ms. These are observational workloads with different filters and users,
not a controlled capacity benchmark.

The first 133.6-second source sample measured 116 network last-seen calls at
28.3 ms mean on Pivnich, compared with iteration 5's 21.25-second largest
batch shape. Its pending queue fell from 72 to 39; oldest age stayed near one
minute, versus 53.6 minutes in iteration 5. Skhid's 26 calls averaged 1.18 ms,
compared with 5.9 seconds previously. Batch contents differ. A later Pivnich
sample averaged 181.7 ms over 146 calls, so the first sample is not a latency
guarantee.

## Remaining Pivnich paths

### Source unit-filtered counts

A matched 133.94-second statement-statistics sample retained one completed
count call at 25.30 seconds and 22.98 GiB of PostgreSQL shared-block reads.
Statistics resets and deallocation counters were unchanged. These block reads
are not confirmed physical storage reads.

The captured creation-cursor query selects ordinary header units or messages
in active networks belonging to matching unit hierarchies. Its plain plan
estimates a sequential scan of 20,324,609 inbox rows despite a selective
message cursor. The unit/network lookup can be pulled into the correlated
message work.

Materializing only the matching network-ID set at the outer statement level
preserves the predicates and snapshot while preventing repeated hierarchy
work. A read-only prototype completed in **390 ms**, with 124 shared-block
reads, 297,215 hits and no temporary writes. Inbox access used the primary
key. No index was added. Cache state and concurrent work were uncontrolled.

Forcing lateral inbox lookups alone exceeded five seconds. Combining lateral
lookups with the materialized network set took 454 ms; the lateral barrier is
therefore unnecessary. Putting the CTE inside the membership subquery retained
the full inbox scan and exceeded five seconds. The outer placement matters.

### Fuzzy search loses gateway predicate pushdown

Between noon and approximately 14:03, native fingerprint
`16607519593784466947` recorded **131 client cancellations**, averaging
24,735 ms and accumulating 3,240 execution seconds. Its SQL is simply
`SELECT id, search_tsv FROM echo_analytics.sigint_search`, with no predicate.
Execution seconds include concurrent work and are not CPU time.

The correlated search constructor wraps its tsquery expression in a scalar
`SELECT` to parse once on PostgreSQL. A gateway reproduction confirms that
this becomes an initplan, leaving tsvector conversion and filtering local and
fetching the search table without a native predicate. The equivalent inline
expression plans as native `match` predicates with no local filter. Explicit
safe ID bounds also push down.

The fix must distinguish source parse-once behavior from analytics expression
construction while retaining message correlation. Prefixes, stop words,
negative terms, OR alternatives, filename and attachment matches require
semantic checks. Analytics pools already force custom prepared plans; inspect
the executed prepared shape rather than relying only on literal SQL.

A separate signal-message read fingerprint had 103 client cancellations and
2,776 execution seconds. Removing the search initplan does not establish that
this other partially pushed-down path is resolved.

### Tagged posts facets multiply intermediate rows

Repeated posts-facet memory failures near 14:00 reached **13.09–14.46 GiB**
of tracked memory. Native SQL joined messages to posts with `ON TRUE`, with
remaining inbox/tag work in the gateway. PostgreSQL logged total-server memory
exhaustion around the shared 17.6-GiB ceiling. A victim query's tracked memory
alone does not account for all concurrent server memory.

Posts still build unresolved per-row tag ownership checks. The earlier sender
fix already resolves accessible tags and unit logins on source. A simplified
posts reproduction with eight accessible tags planned as four foreign scans
before prechecking ownership and one complete foreign scan afterward.

The simplified native diagnostic completed in 204 ms, reading 1,724,886 rows
and tracking 111,105,433 bytes, but returned no rows and omitted the original
AOR/location/metadata combination. It proves a useful plan change, not a
controlled speedup or complete validation of the failing request. Apply the
existing permission-resolution approach to posts without changing association
row counts, inaccessible tags or own-facet-filter removal.

## Skhid before and after the user's repair

At approximately 12:57, the mirror was paused, its source slot inactive and
unconsumed WAL above 10 GiB. The gateway rejected analytics as unhealthy, so
requests fell back to PostgreSQL. The mirror catalog's paused status was last
updated at 10:01:13.

After the user repaired Skhid separately, the mirror reported running with
its status updated at **14:05:20**. At 14:14, the source slot was active with
6,015,088 bytes of lag and a fresh healthy end-to-end heartbeat.

| Response window | Total responses | HTTP 503s | Duty-count responses / 5xx |
| --- | ---: | ---: | ---: |
| 12:48–12:53, before repair | 23,510 | 38 | 3,462 / 20 |
| 14:08–14:13, after repair | 24,582 | 1 | 2,871 / 0 |

Unit-count mean response time fell from 21.7 seconds over six responses to
1.6 seconds over twelve. Workloads differ and the sample is short. One
post-repair 503 still took about 50 seconds; healthy replication does not
resolve every expensive source query.
