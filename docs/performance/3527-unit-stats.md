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
Both aggregates and their union must remain pushed into ClickHouse. An outer
aggregate over a DISTINCT-message subquery joined to a unit-link subquery can
instead transfer millions of rows to PostgreSQL for a local hash join and sort.

Read-only EXPLAIN on Skhid's gateway showed a single Foreign Scan for the new
union, with both aggregates remote; the former shape had two Foreign Scans
below a local Hash Join, Sort and Aggregate. The observed former unit-link
fragment returned about 17.5 million rows per execution. A bounded read-only
execution of the rewritten broad query returned 857 aggregate rows in 14.4
seconds including SSH overhead, under the existing 2.2-GiB query memory limit.
A flat multi-table inner-join alternative still exceeded that memory limit;
the membership query is necessary as well as aggregate pushdown. This is one
measurement under incident load, not a latency guarantee. Keep representative
gateway plan checks alongside source checks when changing this query.

The undefined arm must emit `bigint` and `text` constants to match the linked
arm. An untyped `0` or string literal makes PostgreSQL wrap that arm in a
coercing Subquery Scan, which pg_clickhouse cannot push down: the gateway then
plans an Append of two Foreign Scans and runs the arms one after the other. On
Pivnich in November 2026 the sequential arms took 8 to 18 seconds each and
reached the gateway's 25-second statement timeout under load (`pg_clickhouse:
query was canceled`). With typed constants the same broad query ran as one
Foreign Scan in 15.2 seconds, peaking at 2.01 GiB, 91.5% of the per-query
memory limit. Larger scopes may reach that limit; such failures fall back to
PostgreSQL quickly instead of waiting for the timeout.

The rewritten recent-tail query was also checked locally with 1,000,000
messages, 2,000,000 unit links and 1,000 units. A creation-time index scan
selected 1,001 candidates; the linked aggregate sought the unit-link primary
key for 11 accessible messages instead of scanning all links. The undefined
aggregate used bounded indexed lookups. The combined query took 12.3 ms in
that synthetic projection; this checks the access path rather than deployed
latency.

Unbounded source fallback counts use Duty's existing adaptive cutoff policy,
including concrete unit-ID selections. They retain ordinary source admission;
the bypass for the disjoint recent analytics tail is not used for a 14-day
fallback. Explicit date bounds retain their original meaning.
