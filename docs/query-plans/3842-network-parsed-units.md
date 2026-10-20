# Parsed-unit network matching query plans (#3842)

Measured locally with `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)`
and a 30-second query timeout. Temporary copies of the migrated production
link tables and their existing indexes contained three million item/unit links
(one parsed and two network links per million items) and one million network
links. A minimal item table held one million rows. All tables were analyzed.
This is synthetic scale evidence, not live deployment latency or distribution.
Fixture construction used a separate, longer local timeout.

The application projects item/unit IDs and filters by `kind = 'parsed'` and
bound item IDs. Representative IDs were taken from the end of the population.

| Read | Actual rows | Access path | Execution time |
| --- | ---: | --- | ---: |
| One parsed item | 1 | Index only scan, `(item_id, unit_id, kind)` | 0.278 ms |
| 500 parsed items | 500 | Bitmap index/heap scan, same index | 0.495 ms |
| 20,000 parsed items (rejected batch size) | 20,000 | Sequential scan; 2,980,000 rows discarded | 207.699 ms |
| Existing-network lookup for one item | 1 | Item primary key plus network-link item index, nested loop, limit 1 | 0.241 ms |

The parsed-link loader now caps each query at 500 item IDs using
`SIGINT_INBOX_NETWORK_PARSED_UNIT_QUERY_BATCH_SIZE`, independently of the
older generic 20,000-parameter chunk limit. Both `item_id` and `kind` appear
in the index condition. The 500-item plan touched 1,505 local buffers and had
0.188 ms planning time. No new index or schema change is needed.

The resolver's projected lookup of existing parsed links uses the same item
predicate and index; it also reads the stored UUID to preserve UUID repair.
Recalculation runs only when parsed IDs change and the item already has network
links. New imports perform their normal calculation after resolving units.
The explicit historical unit backfill recalculates its whole batch once,
including unchanged parsed IDs, inside the existing transaction and resume
cursor. The read-only daily consistency check shares the same matching logic.
