# SIGINT frequency list query plans

Captured on 2026-09-21 from the `echo-pivnich` production `wd` database, with
about 17.8 million `sigint_inbox_item` rows. Both SQL variants reproduced the
initial `/api/sigint/freqs` request without optional filters, ordered by
`message_count DESC, freq ASC` and limited to 31 groups. Each comparison used
the same three common group keys sampled from recent messages. The revised
variant skips `DISTINCT ON (signal_message.id)` because the inbox item ID is
unique and these requests have no joins that multiply it.

The measurements used read-only transactions, the server's 8 MB `work_mem`,
defensive statement timeouts, and
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)`.

| Date range | Variant | Time | Shared hit / read blocks | Temp read / written blocks |
| --- | --- | ---: | ---: | ---: |
| 2026-09-14 to 2026-09-21 | Previous | 8,988 ms | 4,040,497 / 315,702 | 0 / 0 |
| 2026-09-14 to 2026-09-21 | Revised | 2,297 ms | 4,204,481 / 12,811 | 0 / 0 |
| 2026-09-07 to 2026-09-21 | Revised | 10,926 ms | 7,877,320 / 354,786 | 0 / 0 |
| 2026-09-07 to 2026-09-21 | Previous | 7,812 ms | 8,206,572 / 289,929 | 1,119 / 1,120 |

The seven-day previous query ran first, while the fourteen-day revised query
ran first. Cache state and concurrent production load changed between runs, so
the times alone do not establish a latency improvement. Both variants returned
the same 87,574 qualifying rows and 321 frequency groups for seven days, and
171,027 rows and 390 groups for fourteen days.

For fourteen days, both plans used
`sigint_inbox_item_datetime_idx` with an `Index Cond` on the requested range.
The revised plan visited about 844,000 date-range inbox rows and made 815,000
message lookups, then used an in-memory sort on `(freq, location_v2)` before
`GroupAggregate`. The previous plan also sorted by message ID and datetime for
`Unique`; its later group sort used an external
merge and 8,952 kB of disk. The final 31-row sort used a bounded top-N heapsort
in both plans.

The date predicate bounds the index range, but `LIMIT 31` does not bound the
message work: exact counts and count ordering require all matching messages.
The revised query avoids the observed fourteen-day spill but still performs
about 815,000 message lookups and 814,000 group-membership probes. Treat the
limit as a response-size bound, not as a latency fix for broad date ranges.
