# Ranked unit search query plans (#3388)

Captured on 2026-09-07 from a dedicated database restored with
`deploy/setup_test_database.sh 3388_ranked_cursor_codex` and migrated to the
branch head. The stress fixture contained 100,000 active units across all 14
echelons. A two-token relaxed search matched 10,104 rows, including exact and
fuzzy matches. The table was analyzed before measurement.

Measurements used:

```sql
SET statement_timeout = '30s';
SET track_io_timing = on;
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) ...;
```

## First 20 rows

- Ranked search executed in 240.749 ms, compared with 222.291 ms for the
  previous natural-order query.
- Both plans used a parallel sequential scan because relaxed similarity must
  score the complete catalog. The ranked plan touched 2,497 shared buffers,
  compared with 2,487 for the previous plan.
- The exact-match expression normalizes the concatenated unit fields once and
  compares both token patterns with `LIKE ALL`.
- Both workers used bounded top-N heapsorts of 33–34 kB with no temporary I/O.

## Rows 5,001–5,020

- Ranked search executed in 287.209 ms.
- Both workers used in-memory quicksorts of 1,522–1,547 kB with no temporary
  I/O.
- The plan touched 2,497 shared buffers: 1,352 hits and 1,145 reads.
