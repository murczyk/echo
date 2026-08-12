# Redis group statistics

## Outcome

The group-statistics worker stores derived group, facet, and network
aggregates in the installation's existing Redis service. PostgreSQL remains
the system of record for messages,
`signal_group_batch`, `group_stats_recalculation_task`, and
`sigint_network_freq.last_seen_dt`.

This is a storage change, not an API change. Existing callers keep their
response types and filtered requests keep their raw PostgreSQL or analytics
paths.

The former PostgreSQL aggregate tables and backend selection code were removed
after every deployment was backfilled and verified against Redis.

## Configuration

```toml
group_stats_redis_db = 1
```

Redis database 0 stays reserved for sessions and transient application state.
Statistics default to logical database 1.

## Bucket layout

Keys use the `echo:group-stats:v3` prefix. Values are postcard records
compressed with zstd level 3. Completed empty buckets are stored explicitly,
so absence means incomplete data rather than a zero count. The v3 namespace
separates HLL-backed facet buckets from v2 integer counters; old v2 keys expire
through their existing native TTLs. After installing a v3 binary, run
`sudo wdintel-rs --mode=live oneoff-calculate-historic-stats` before deploying
Echo so historical requests do not synchronously rebuild their cache.
Network days are Redis hashes with one compressed field per active network and
a completion marker, allowing readers and invalidation tasks to touch only the
requested networks.

| Key family | Resolution | Contents | Retention |
|---|---:|---|---:|
| `5m:group` | 5 minutes | group-batch counts for timelines and totals | 91 days |
| `5m:detail` | 5 minutes | AOR, post, tag, sender, frequency, callsign, unit, and location HLL sketches | 16 days |
| `day:general` | local day | group counts and merged detailed-facet HLL sketches | 367 days |
| `day:network` | local day | network, network-frequency, and network-callsign counts | 367 days |

Every write atomically sets the value and an absolute native Redis expiry.
There is no cleanup worker. Historical five-minute results outside their
retention are aggregated in memory into daily values and then discarded.

Detailed facets hash `signal_message.id`, not message-group rows. A sparse
sketch stores the complete message-ID set until 2,048 IDs; it then promotes to
a precision-14 HLL register array (about 0.8% relative standard error).
Readers union sketches over the selected groups and time buckets, which counts
a message that appears in several groups or buckets once. HLLs are never
incrementally corrected: historical changes rebuild and replace their complete
buckets.

The worker keeps its existing five-minute calculation semantics. The regular
two-minute pass refreshes the last hour and affected local days; the ten-second
short pass refreshes the current bucket. Network invalidation replaces only
the affected networks in a daily value. This avoids both partial-day loss and
unbounded key growth.

## Missing-data behavior

A missing or corrupt value is never interpreted as zero. Supported aggregate
reads rebuild missing buckets from authoritative PostgreSQL source rows and
retry once. Old ranges that need expired partial-day detail are routed through
the existing raw PostgreSQL path. Timeline reads also fall back to the raw
query when their Redis history is incomplete.

Redis should retain `noeviction`: failing a stats write is safer than evicting
sessions or returning a silently incomplete aggregate.

## PostgreSQL load story

The PostgreSQL investigation found two separate problems:

1. common statistics reads could depend on a badly underestimated, recently
   inserted datetime tail and degrade into hundreds of thousands of nested-loop
   probes;
2. aggregate maintenance issued hundreds of millions of individual inserts,
   creating protocol, planning, executor, WAL, and index work.

Redis improves both paths. Common group-stat reads become bounded `MGET` or
network-hash field operations and no longer depend on PostgreSQL choosing a
good join plan for the recent tail. Worker output becomes a bounded set of
compressed bucket values instead of one SQL insert per aggregate row.

The worker still reads bounded source windows from PostgreSQL, and raw fallback
queries still need healthy PostgreSQL statistics. Redis therefore complements,
but does not replace, the archive's recommendation to keep automatic analyze
responsive on `sigint_inbox_item.datetime`.

## Memory

The initial row-count estimate treated PostgreSQL row volume too much like
Redis payload volume. Production v2 backfills measured approximately 6–169 MiB
of total Redis memory across the rollout hosts, including pre-existing Redis
data. V3 adds a sparse exact-ID representation for small facet buckets and a
16 KiB dense HLL register array for each high-cardinality facet/group/bucket;
the payload therefore must be measured after every full backfill. Budget 512
MiB steady-state and 1 GiB during a v2→v3 transition or RDB copy-on-write;
increase the Redis limit before backfill if the measured peak approaches it.

Measure the actual result after backfill with:

```sh
redis-cli -n 1 DBSIZE
redis-cli -n 1 INFO memory
redis-cli -n 1 --scan --pattern 'echo:group-stats:v3:*' |
  head
```

Redis 6.0 supports the `SET` plus `EXPIREAT` transaction used here.
