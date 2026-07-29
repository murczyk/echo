# 2026-07-29: PostgreSQL query optimization follow-up

## Scope and safety

This follow-up investigated the pure PostgreSQL path after the optional
PeerDB/ClickHouse rollout. Production inspection on `echo-pivnich` was
read-only. No production configuration, schema, data, service, or statistics
state was changed. Diagnostic queries used `default_transaction_read_only`,
short `statement_timeout` values, and plan-only `EXPLAIN`; no production
`EXPLAIN ANALYZE` was run.

The initial example was:

```text
POST /api/user/sigint-groups
since_date_inclusive_ms=1785127608714
```

The supplied timestamp is `2026-07-27 04:46:48.714 UTC`.

The follow-up examples were:

```text
POST /api/sigint/latest-frequencies
POST /api/rer/analysis/stats/posts
```

The post-stats request covered
`2026-07-15 05:04:29.911 UTC` through
`2026-07-30 05:04:29.911 UTC`, with no effective facet filters.

## Production evidence

At inspection time:

- PostgreSQL was 18.4.
- `pg_stat_statements` had been reset at
  `2026-07-28 09:32:35 UTC`.
- `signal_message` had about 14.7 million live rows and occupied about
  13.8 GiB including indexes.
- `signal_message_group` had about 22.9 million live rows and occupied about
  4.4 GiB including indexes.
- The relevant existing indexes were
  `signal_message(timestamp, id)` and
  `signal_message_group(signal_message_id, group_master_key)`.

The exact supplied request was present in the PostgreSQL slow log:

```text
duration: 16956.286 ms
```

For this query shape, `pg_stat_statements` reported:

| Calls | Mean | Maximum | Rows returned |
| ---: | ---: | ---: | ---: |
| 268 | 10.221 s | 19.403 s | 13,528 |

The original plan built a parallel hash join. It used the second column of
`signal_message_group(signal_message_id, group_master_key)` to filter 103
allowed groups and estimated that it would inspect about 18.3 million
historical group rows. Only about 246 thousand messages satisfied the
two-day timestamp predicate.

Adding the reverse index
`signal_message_group(group_master_key, signal_message_id)` alone is therefore
not the best fix. The allowed set covered 103 of the 178 statistically
distinct groups, so it would still read most historical group entries.

## Implemented fix

`read_active_sigint_groups_since` now materializes the recent message IDs once
and adds their minimum ID as a lower bound on `signal_message_group`:

```sql
with recent_messages as materialized (
    select id
    from signal_message
    where "timestamp" > $1
)
select smg.group_master_key
from recent_messages sm
inner join signal_message_group smg
    on smg.signal_message_id = sm.id
where smg.signal_message_id >= (
    select min(id)
    from recent_messages
)
  and smg.group_master_key = any($2::text[])
group by smg.group_master_key;
```

This is exact rather than an ID/time-correlation approximation. If `M` is the
minimum ID among messages satisfying the timestamp predicate, every qualifying
message necessarily has `id >= M`. The original timestamp predicate remains
authoritative through `recent_messages`, so newer IDs belonging to old
messages cannot become false positives. When there are no recent messages,
both the CTE and the result are empty.

For the production parameters, qualifying IDs occupied a range of 247,447
values rather than the full historical table. A read-only production execution
of the final query, capped by a five-second statement timeout, returned 76
groups in:

```text
917.783 ms
```

This is about 18 times faster than the logged 16.956-second request and needs no
new index or migration.

The same helper is attempted through the optional PostgreSQL analytics gateway
before application-level fallback. The query is standard PostgreSQL 18 SQL;
gateway pushdown behavior still needs to be observed during normal rollout.
An analytics error or timeout continues to use the optimized source
PostgreSQL query.

## Follow-up endpoints

### Production evidence

The slow log and application timing logs confirmed both additional request
shapes:

- `latest-frequencies` took between 10 and 27 seconds in the observed burst;
- the matching unfiltered post-stats request took 29.479 seconds.

Since the `pg_stat_statements` reset, the normalized query shapes had:

| Endpoint | Calls | Mean | Maximum | Temporary blocks written |
| --- | ---: | ---: | ---: | ---: |
| Latest frequencies | 284 | 14.133 s | 26.755 s | 12,655,941 |
| Post stats | 276 | 18.775 s | 32.380 s | 13,016,834 |

Both original queries filtered `sigint_inbox_item.datetime` but let PostgreSQL
consider group rows from the full 22.9-million-row
`signal_message_group` table. The wide access list makes filtering on
`group_master_key` alone insufficient.

### Implemented exact recent-inbox bound

Both paths now materialize the authoritative inbox time range and its minimum
message ID:

```sql
with recent_inbox as materialized (
    select id, ...
    from sigint_inbox_item
    where datetime >= $1
      -- post stats also has: and datetime < $2
),
recent_bounds as materialized (
    select min(id) as min_id
    from recent_inbox
)
select ...
from recent_inbox ri
inner join signal_message sm on sm.id = ri.id
inner join signal_message_group smg
    on smg.signal_message_id = ri.id
cross join recent_bounds rb
where smg.signal_message_id >= rb.min_id
  and smg.group_master_key = any($N::text[]);
```

The lower bound is redundant for correctness but important for planning: it
turns the existing
`signal_message_group(signal_message_id, group_master_key)` index into a
recent-ID range scan. The `recent_inbox` join and original `datetime`
predicates remain authoritative, so a newer ID carrying an old message time is
still excluded.

`latest-frequencies` uses this path for every request and retains the original
deleted-message, access-group, null-frequency, distinct, and sort semantics.

Post stats uses the optimized query only when the request has no effective
facet filters, which covers the supplied request. It retains the inner post
join and `COUNT(DISTINCT message_id)`, so messages linked to multiple allowed
groups are still counted once. Filtered requests continue through the generic
query builder.

Production plan-only validation showed:

- `recent_inbox` driven by `sigint_inbox_item_datetime_idx`;
- the group join driven by an index-only range scan on
  `signal_message_group_signal_message_id_group_master_key_idx`;
- approximately 436 thousand candidate inbox rows for the seven-day frequency
  request and 776 thousand for the supplied post-stats window, instead of
  considering the complete group history.

Broader-than-request production runtime probes were protected by a five-second
statement timeout and were canceled at the cap. No uncapped probe or
`EXPLAIN ANALYZE` was run on production. Deployment measurements are therefore
required before claiming an endpoint latency result for these two paths.

Regression tests cover:

- higher IDs with datetimes outside the requested range;
- denied groups and deleted messages;
- null and duplicate frequencies;
- multiple allowed group links for one message without double-counting posts.

## Rejected shortcut: `signal_message_group.created_at`

Filtering and indexing `signal_message_group.created_at` would remove the join,
but it changes semantics. The endpoint currently filters
`signal_message.timestamp`.

Around the investigated boundary, production had:

- 246,196 messages recent by `timestamp`;
- 246,212 messages recent by `created_at`;
- 16 messages recent by `created_at` whose `timestamp` was outside the range;
- 27 timestamp-recent messages with more than a five-minute difference between
  `created_at` and `timestamp`.

Do not switch columns silently. It requires an explicit product decision if
ingestion time is acceptable instead of message time.

## Deferred PostgreSQL optimization paths

### 1. Cache access-group resolution with explicit invalidation

Two access-group query shapes made about 28.6 million calls and accumulated
about 22.1 hours of database execution time since the statistics reset. Their
individual latency was only 2.4-3.5 ms, but they ran hundreds of times per
second.

Cache results by login and an access-control revision, or explicitly invalidate
entries whenever organism, AOR, zone, archive, datasource, or secret-group
membership changes. A blind long TTL is inappropriate because revoked access
must not remain visible.

### 2. Remove the `echo-im` monitoring polling amplification

The known query:

```sql
select account_id, max(created_at)
from echo_inbox_message
group by account_id;
```

ran about 1.63 million times, averaged 41.7 ms, and accumulated about 19 hours
of database execution time. The follow-up already identified in
`archive/2026-07-05-datasource-group-bloat/README.md` remains valid: restart
checks in `echo-im` should use live client state or a cached per-account
watermark instead of collecting full monitoring data on every tick.

### 3. Specialize and cache message count queries

The two most expensive count/min-timestamp variants accumulated about
50.6 hours of database execution time and averaged 16.9-19.9 seconds per call.
The generic query builder emits joins even when a request does not filter their
tables, and some shapes contain repeated message-group access predicates.

Profile each dominant `queryid`, then:

1. remove unused `LEFT JOIN`s from count-only paths;
2. deduplicate identical access `EXISTS` predicates;
3. cache identical filter fingerprints for short intervals;
4. serve common time/group counts from maintained aggregates;
5. keep the raw PostgreSQL path as a correctness fallback.

Do not add speculative indexes before checking the reduced query plans.

The unfiltered post-stats specialization implemented above is the first
instance of this approach. A later pass can carry the exact recent-ID envelope
through the generic filtered post-stats query and the other dominant facet
queries.

### 4. Batch statistics writes

One statistics insert shape executed about 168 million times. Replace
per-row SeaORM inserts with bounded multi-row inserts, `UNNEST`, or `COPY`
where transaction and conflict semantics allow it. This is primarily protocol,
planning, WAL, and executor overhead rather than a missing-index problem.

### 5. Optional sub-100-ms group activity summary

If the optimized approximately one-second endpoint is still too slow, maintain
one exact latest-message timestamp per group and filter the 100-200 summary
rows. Updates should be batched and conditional to avoid recreating the
`datasource_group` write/bloat incident.

An alternative is a denormalized message timestamp on
`signal_message_group` with an index on
`(message_timestamp, group_master_key)`. It costs substantially more storage
and write amplification across about 23 million rows, needs a controlled
backfill, and must follow the replicated-column review rules in
`CODE_REVIEW.md`.

### 6. Optional covering inbox datetime index

The new frequency and post-stats plans still fetch `id`, `freq`, or `post_id`
from the heap while scanning `sigint_inbox_item_datetime_idx`. If deployment
measurements show that this remains dominant, compare a covering index such as
`(datetime, id) INCLUDE (freq, post_id)` against separate narrower indexes.

Do not create it speculatively: `sigint_inbox_item` is about 19 GiB, the index
would add write amplification and substantial storage, and the existing
non-covering datetime index may be replaceable rather than duplicated.

## Operational follow-up

After deployment:

1. confirm all three endpoint query shapes in `pg_stat_statements`;
2. compare mean, maximum, shared blocks, and temporary blocks per call;
3. inspect whether the analytics gateway succeeds or falls back;
4. compare old and new results on a non-production snapshot;
5. verify that generic filtered post stats still uses its original path;
6. reset statistics only in a separately approved measurement window.
