# Unresolved-unit message pagination query plans

Captured on 2026-09-17 from a dedicated database restored with
`deploy/setup_test_database.sh unresolved_unit_message_review` and migrated to
the branch head. The fixture contained 1,000,000 signal messages, inbox items,
and active failed-label links split evenly between two labels. All 500,000
messages for the measured label preceded 500,000 messages for the other label.
The tables were analyzed before measurement.

Measurements used:

```sql
SET statement_timeout = '30s';
SET track_io_timing = on;
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) ...;
```

## First six rows

- Execution time: 0.489 ms.
- Buffers: 54 shared hits and 7 reads; no temporary I/O.
- `sigint_inbox_item_failed_unit_label_active_message_idx` returned six ordered
  links with an index-only scan. Message and group enrichment ran only for
  those six candidates, and the final in-memory sort contained six rows.
- The previous query executed in 363.633 ms, touched 1,500,932 shared buffers
  and read 9,637, scanned 500,006 global message-index entries, and performed
  500,006 failed-label index probes before finding six matching rows.

## Six rows after a 250,000-row cursor

- Execution time: 0.676 ms.
- Buffers: 56 shared hits and 5 reads; no temporary I/O.
- The composite label, timestamp, and message-ID cursor appeared in the index
  condition. The index-only scan and message primary-key lookup each returned
  six rows, so the access path did not walk the preceding history.
