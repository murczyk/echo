# Duty unit-count query access

The unit facet uses the ordinary inbox access and non-unit filters, then counts
distinct message IDs for each non-deleted linked unit. Multiple link kinds do
not multiply a unit's count. The undefined bucket covers messages without a
non-deleted linked unit.

The analytics path applies the inbox message-ID scope to unit links as well as
messages. Recent creation-time rows come from PostgreSQL using a disjoint
lower-bound partition. Both partitions count distinct message IDs to avoid
multiplying a unit's count across parsed and network links. The route participates
in read deadlines and count-search safeguards. Frontend requests run for open
filter panels; inbox changes coalesce behind active requests and the configured
refresh interval. Parent counts are enriched in Rust from the Redis hierarchy
cache, using one bottom-up pass over group totals.

## Previous source baseline

Before the aggregate rewrite, local PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` used the SQL
emitted by `inbox_unit_counts_respect_duty_exclusions_3527` and projection tables
with 1,000,000 messages, 1,000,000 group links, 1,000 units, and 2,000,000 unit
links. Each message had parsed/network link kinds. The test user could access
1% of messages, and the frequency exclusion removed half of that subset. The
recent partition contained 1,001 messages. Relevant index definitions matched
the deployed source indexes. Tables were temporary in the dedicated test
database, with a 60-second statement timeout and 32 MB work memory.

The recent-tail plan sought the creation-time index, hydrated 11 accessible
inbox candidates by primary key, and sought unit links for six matching
messages:

```text
Index Scan using signal_message_created_at_id_idx
  actual rows=1001 loops=1
  Index Cond: created_at >= '2026-10-31 12:00:00'
Index Scan using sigint_inbox_item_pkey
  actual rows=1 loops=11
Index Only Scan using sigint_inbox_item_unit_pkey
  actual rows=2 loops=6
  Index Cond: item_id = signal_message.id
```

One paired execution measured 29.214 ms for the ordinary recent-tail join and
17.573 ms for the bounded lateral lookup. Full-history plans varied between
an indexed lookup and a scan of all unit links as estimates changed; forcing
lateral access for that case increased one execution from 130.313 ms to
427.718 ms, so the baseline retained the ordinary join.

These projection tables establish the access path, not production I/O or a
latency guarantee. A full-history count can still scan large relations and must
remain subject to the route deadline and analytics fallback capacity controls.
ClickHouse gateway execution requires the optional analytics environment;
source plan measurements do not establish its latency.

## Gateway aggregation

Duty counts aggregate active unit links filtered by a message-ID semi-join and
use a separate anti-join aggregate for the undefined bucket, combined with
UNION ALL. Filtering links by membership avoids multiplying joined rows and
keeps the linked-count hash state below the gateway's per-query memory limit.
This preserves distinct-message counts across multiple link kinds and includes
messages whose only unit links target deleted units in the undefined bucket.
Each aggregate must remain pushed into ClickHouse. An outer aggregate over a
DISTINCT-message subquery joined to a unit-link subquery can instead transfer
millions of rows to PostgreSQL for a local hash join and sort. The UNION itself
must not be pushed down; see below.

Read-only EXPLAIN on Skhid's gateway showed a single Foreign Scan for the new
union, with both aggregates remote; the former shape had two Foreign Scans
below a local Hash Join, Sort and Aggregate. The observed former unit-link
fragment returned about 17.5 million rows per execution. A bounded read-only
execution of the rewritten broad query returned 857 aggregate rows in 14.4
seconds including SSH overhead, under the existing 2.2-GiB query memory limit.
A flat multi-table inner-join alternative still exceeded that memory limit;
the membership query is necessary as well as aggregate pushdown. This is one
measurement under incident load, not a latency guarantee. Keep representative
gateway plan checks alongside source checks when changing this query. The
deployed query does not produce that single scan: its two aggregates run as
separate Foreign Scans, as described below.

The two aggregates must stay separate gateway queries. The undefined arm emits
an untyped `0` and name literal, so PostgreSQL wraps it in a coercing Subquery
Scan that pg_clickhouse does not push down: the gateway plans an Append of two
Foreign Scans and runs the arms one after the other, each with its own 2.2-GiB
query memory limit. In November 2026 these constants were cast to `bigint` and
`text` so the whole UNION became one Foreign Scan (#4086). That merged both
hash states into one query: on Pivnich it peaked at 2.01 GiB, and on Skhid a
23-group scope exceeded the limit on every execution while its sequential arms
had used at most 1.14 and 1.75 GiB. The failures fell back to an already busy
PostgreSQL source, and the change was reverted. Latency gained little: one
query took 15.2 seconds against about 16 seconds sequential on Pivnich, and
about 8 seconds either way on Skhid. A test pins the untyped constants. Do not
merge the arms until the undefined arm's anti-join is narrowed to the scoped
messages and per-scope peak memory is measured on every analytics host; see
[the incident notes](../../archive/2026-11-09-3527-unit-stats-union-pushdown/README.md).

## Message-ordered unit links

On the analytics gateway both arms read
`echo_clickhouse_derived.message_unit_link`, a copy of
`sigint_inbox_item_unit` ordered by `(item_id, id)`, and bound it by the same
message-ID scope as the messages (#4202). PeerDB orders the raw table by its
surrogate `id`. A scope there pruned nothing, so every execution read the whole
table `FINAL`: about 189 million rows on Pivnich, three quarters of them
deletion markers. The derived copy prunes by primary key, so the anti-join's
hash holds only the links of the scoped messages. The arms stay separate until
their peak memory with the narrowed anti-join has been measured on every
analytics host.
