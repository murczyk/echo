# Message unit query plans (#3535)

Plans were checked on PostgreSQL 14 with `pg_uuidv7` using temporary `LIKE ...
INCLUDING ALL` copies of the migrated tables. The fixture had 100,000 units,
75% inactive, across 100 parent names, and 100,000 explicit inbox selections.
Messages had approximately 4 KiB bodies for the body-hash comparison.
Temporary copies preserved the application's indexes without changing shared
application data. Queries used `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY
ON)` with a 60-second statement timeout.

| Query | Returned rows | Execution time |
| --- | ---: | ---: |
| Previous broad autocomplete, maximum 100,000 | 100,000 | 18.221 ms |
| Bounded broad autocomplete, maximum 250 | 250 | 0.104 ms |
| Parent-name search, maximum 250 | 250 | 6.506 ms |
| Three exact recent names | 3 | 0.063 ms |
| Direct-submit exact name, maximum 2 | 1 | 0.008 ms |
| One explicit inbox selection | 1 | 0.138 ms |
| Backfill batch of 500 explicit selections | 500 | 3.325 ms |

The earlier exact-history query ordered by the original name and scanned
99,997 unrelated rows in 215.256 ms. Ordering exact-name lookups by the same
normalized expression as their predicate made that expression an `Index Cond`:

```sql
where deleted = false
  and lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g'))
      in ('рота 3535 35 полк', 'рота 1200 0 полк', 'рота 99199 99 полк')
order by lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')), id
limit 250
```

The broad bounded query used the name index and incremental sorting, reading
251 candidate rows rather than returning the entire relation. Parent searches
still filter candidates through the name index, so performance depends on
where matching names occur. An additional indexed exact-name lookup puts exact matches first without
loading more than 250 total units. The client debounces input and users can narrow
the phrase to find further children.

Selection lookups sought the selection, unit, inbox, and message primary keys
and computed the current source-body hash; the 500-item batch used one SQL query with bounded index probes. They did
not scan the inbox or selection relation. Direct-submit name matching sought
the existing normalized-name index. No additional search index was required.

These are fixture measurements under concurrent local builds, not production
latency guarantees. The durable guarantees are bounded result sizes and the
indexed exact-name and selection access paths. See the
[unit selection behavior](../../wdintel-rs/src/sigint/direct_submit/README.md).
