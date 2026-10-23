# Unit visibility refresh query plans

Read-only measurements on echo-pivnich, PostgreSQL 18.4, 2026-10-22.
All measured historical reads used `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF,
SUMMARY ON)` with a 5-second statement timeout. No unit writes or trigger
executions were performed during these checks.

The deployed synchronous trigger expanded the complete direct-link/callsign
history inside unit writes. Successful activity updates recorded a 6.3-second
mean and a 29.8-second maximum; PostgreSQL logs also recorded statement timeouts
inside `capture_api_integration_iggy_unit_visibility`. The callsign relation had
approximately 27 million rows and unit links approximately 25 million rows.
The relevant indexes were valid and ready.

The replacement pages historical work using these seek conditions:

| Read | Index and index condition | Rows returned | Execution time |
| --- | --- | --- | --- |
| Direct links | `sigint_inbox_item_unit_unit_id_id_idx`; `unit_id = $unit AND id > $cursor` | 500 | 22.789 ms |
| Inbox callsign matches | `sigint_inbox_item_callsign_active_iggy_match_key_idx`; normalized callsign key equality and `sigint_inbox_item_id > $cursor` | 500 | 27.770 ms |
| Network callsign matches | `sigint_network_callsign_active_match_key_network_idx`; normalized callsign key equality and `(sigint_network_id, id) > ($network, $cursor)` | 2 | 0.159 ms |

The inbox query uses streaming `Unique` over the ordered index and stops at its
page limit. None of these plans uses a full-history aggregate, an offset, or a
sort of all matches. Catalog key lookup uses
`sigint_callsign_unit_id_id_idx` with `unit_id = $unit` and `id >= $cursor`.

These timings cover historical selection, rather than outbox insertion or
publication latency. Expansion commits at most 500 direct/inbox updates or
1,000 network events per transaction. Queue selection is supported by
`api_integration_iggy_unit_refresh_ready_idx (next_attempt_at, id)`; its due-time
predicate uses stable `now()` so it can appear in the index condition.

With 100,000 jobs in a local PostgreSQL 14 database, including 99,990 delayed
jobs, the exact ready-job claim used that index with the due-time range as its
`Index Cond`. It returned and locked one ready row in 0.032 ms, touching five
shared buffers, without sorting or scanning the delayed jobs.
