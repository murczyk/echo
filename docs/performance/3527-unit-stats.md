# Duty unit-count query access

The unit facet uses the ordinary inbox access and non-unit filters, then counts
distinct message IDs for each non-deleted linked unit. Multiple link kinds do
not multiply a unit's count. The undefined bucket covers messages without a
non-deleted linked unit.

The analytics path applies the inbox message-ID scope to unit links as well as
messages. Recent creation-time rows come from PostgreSQL using a disjoint
lower-bound partition; that partition uses a lateral unit-link lookup with
`item_id = messages.id OFFSET 0`, allowing the existing `(item_id, unit_id,
kind)` index to seek for each candidate. Full-history PostgreSQL fallback keeps
a set-based join, allowing the planner to choose between indexed and sequential
access as the visible share changes. The route participates in read deadlines
and count-search safeguards. Frontend requests are lazy, cached across toggles,
and coalesced after inbox changes.

## Source plan evidence

Local PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` used the SQL
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
427.718 ms, so full-history fallback deliberately retains the ordinary join.

These projection tables establish the access path, not production I/O or a
latency guarantee. A full-history count can still scan large relations and must
remain subject to the route deadline and analytics fallback capacity controls.
ClickHouse gateway execution requires the optional analytics environment;
source plan measurements do not establish its latency.
