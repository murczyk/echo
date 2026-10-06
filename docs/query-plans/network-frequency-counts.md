# Network frequency count query plans

Captured on 2026-10-06 from the `echo-pivnich` production `wd` database for
network 834. The database contained about 18.9 million `sigint_inbox_item`,
12.8 million `sigint_inbox_item_network`, and 23.5 million `signal_message`
rows. Measurements used read-only transactions, defensive statement timeouts,
and `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)`.

The previous exact-count query repeatedly scanned all inbox rows for each
frequency before applying the requested day and network. With the 13 actual
intra-day boundary requests, it took 10,299 ms, used 4,126,777 shared hit and
27,818 shared read blocks, visited 423,239 frequency rows, and performed
358,938 message lookups. At capture time, `pg_stat_statements` reported 583
calls with an 8,331 ms mean and a 29,896 ms maximum; failed 30-second
statement-timeout executions were visible in the application log.

The revised dated path drives each request through both frequency and datetime
bounds, materializes the small candidate set, and applies the network join
before message authorization. A deliberately larger 33-request workload took
1,441 ms, used 88,117 shared hit and 6,251 shared read blocks, reduced 7,810
dated candidates to 7,716 network candidates, and authorized 7,696 messages.

The dated candidate lookup still used a `BitmapAnd` over the separate `freq`
and `datetime` indexes. A representative production boundary lookup scanned
366 frequency entries and 63,192 datetime entries, read 256 shared blocks, and
took 14.6 ms to return one row. The partial covering
`sigint_inbox_item (freq, datetime) INCLUDE (id) WHERE datetime IS NOT NULL`
index gives the parameterized lookup a single bounded access path while
excluding the undated fallback rows.

Rows without `sigint_inbox_item.datetime` retain the existing timestamp
fallback semantics. Production checks found no such rows among any network
link and none for network 834's 27 frequencies. The partial
`sigint_inbox_item (freq, id) WHERE datetime IS NULL` index makes that fallback
a bounded frequency lookup without enlarging the index for the other roughly
94% of inbox rows. After rollout, repeat the full endpoint plan and compare a
short `pg_stat_statements` delta to confirm that the dated lookup uses the new
index and that latency remains bounded under live cache and concurrency
conditions.
