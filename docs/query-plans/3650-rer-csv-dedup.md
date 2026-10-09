# RER CSV duplicate lookup (#3650)

Measured locally on PostgreSQL 14 on 2026-10-09 with a 30-second
`statement_timeout`. These are production-scale synthetic cardinalities,
not a measurement of production latency or production body distributions.
Temporary relations mirrored the projected columns and relevant indexes:
1,000,000 messages (950,000 active), 1,000,000 group links across ten groups,
950,000 inbox IDs, and 10,000 recovery records. Bodies were distinct except
for their common timestamp/header. All relations were analyzed.

The catalog of the restored standard dump had no equivalent body-fingerprint
index. Existing timestamp/creation indexes cannot serve this identity.
The production group-access index is
`signal_message_group_group_master_key_signal_message_id_idx`.

Plain `EXPLAIN` before adding the body index selected a sequential message
scan. Plain `EXPLAIN` after adding the migration's `(md5(body), id)` partial
index selected a bitmap index scan. `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF,
SUMMARY ON)` then confirmed one candidate, exact-body filtering, and indexed
group membership. The hit took 0.590 ms with 3 local buffer hits and 11 reads;
a miss took 0.043 ms with 1 hit and 2 reads. Neither visited a whole group.

PostgreSQL 14 estimated 4,755 fingerprint candidates where the actual count
was one; the measured access path remained bounded by matching fingerprints.
Very frequent identical bodies can increase candidate work; full equality
still decides identity, including in the event of a fingerprint collision.
Index maintenance adds a body hash to active-message writes. Concurrent index
creation avoids holding a table write lock for the build.

The captured baseline plans follow. They use the previous active-only lookup
from `wdintel-rs/src/rer_importer/import_csv/persistence.rs`; measurements of
the updated lookup are below.

```text
SET
CREATE TABLE
CREATE TABLE
CREATE INDEX
CREATE TABLE
CREATE TABLE
INSERT 0 1000000
INSERT 0 1000000
INSERT 0 950000
INSERT 0 10000
ANALYZE
ANALYZE
ANALYZE
ANALYZE
PREPARE
                                                                              QUERY PLAN                                                                               
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=26870.78..26879.24 rows=1 width=11)
   ->  Result  (cost=26870.78..26879.24 rows=1 width=11)
         ->  Sort  (cost=26870.78..26870.78 rows=1 width=10)
               Sort Key: m.id
               ->  Nested Loop Semi Join  (cost=0.71..26870.77 rows=1 width=10)
                     ->  Nested Loop Left Join  (cost=0.29..26854.30 rows=1 width=24)
                           ->  Seq Scan on signal_message m  (cost=0.00..26846.00 rows=1 width=8)
                                 Filter: ((NOT deleted) AND (body = '02.10.2026 10:16:00
 message 999991'::text) AND (md5(body) = '20732d8667266d5c51cb35484b3c15a8'::text))
                           ->  Index Scan using rer_csv_import_message_pkey on rer_csv_import_message p  (cost=0.29..8.30 rows=1 width=16)
                                 Index Cond: (message_id = m.id)
                     ->  Index Only Scan using signal_message_group_group_master_key_signal_message_id_idx on signal_message_group g  (cost=0.42..8.45 rows=1 width=8)
                           Index Cond: ((group_master_key = 'group-1'::text) AND (signal_message_id = m.id))
         SubPlan 1
           ->  Index Only Scan using sigint_inbox_item_pkey on sigint_inbox_item i  (cost=0.42..8.44 rows=1 width=0)
                 Index Cond: (id = m.id)
(16 rows)

CREATE INDEX
ANALYZE
                                                                              QUERY PLAN                                                                               
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=8224.74..8233.19 rows=1 width=11)
   ->  Result  (cost=8224.74..8233.19 rows=1 width=11)
         ->  Sort  (cost=8224.74..8224.74 rows=1 width=10)
               Sort Key: m.id
               ->  Nested Loop Semi Join  (cost=196.80..8224.73 rows=1 width=10)
                     ->  Nested Loop Left Join  (cost=196.37..8208.26 rows=1 width=24)
                           ->  Bitmap Heap Scan on signal_message m  (cost=196.09..8199.96 rows=1 width=8)
                                 Recheck Cond: ((md5(body) = '20732d8667266d5c51cb35484b3c15a8'::text) AND (NOT deleted))
                                 Filter: (body = '02.10.2026 10:16:00
 message 999991'::text)
                                 ->  Bitmap Index Scan on signal_message_active_body_fingerprint_idx  (cost=0.00..196.09 rows=4755 width=0)
                                       Index Cond: (md5(body) = '20732d8667266d5c51cb35484b3c15a8'::text)
                           ->  Index Scan using rer_csv_import_message_pkey on rer_csv_import_message p  (cost=0.29..8.30 rows=1 width=16)
                                 Index Cond: (message_id = m.id)
                     ->  Index Only Scan using signal_message_group_group_master_key_signal_message_id_idx on signal_message_group g  (cost=0.42..8.45 rows=1 width=8)
                           Index Cond: ((group_master_key = 'group-1'::text) AND (signal_message_id = m.id))
         SubPlan 1
           ->  Index Only Scan using sigint_inbox_item_pkey on sigint_inbox_item i  (cost=0.42..8.44 rows=1 width=0)
                 Index Cond: (id = m.id)
(19 rows)

                                                                                          QUERY PLAN                                                                                           
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=8224.74..8233.19 rows=1 width=11) (actual rows=1 loops=1)
   Buffers: local hit=3 read=11
   ->  Result  (cost=8224.74..8233.19 rows=1 width=11) (actual rows=1 loops=1)
         Buffers: local hit=3 read=11
         ->  Sort  (cost=8224.74..8224.74 rows=1 width=10) (actual rows=1 loops=1)
               Sort Key: m.id
               Sort Method: quicksort  Memory: 25kB
               Buffers: local hit=3 read=7
               ->  Nested Loop Semi Join  (cost=196.80..8224.73 rows=1 width=10) (actual rows=1 loops=1)
                     Buffers: local hit=3 read=7
                     ->  Nested Loop Left Join  (cost=196.37..8208.26 rows=1 width=24) (actual rows=1 loops=1)
                           Buffers: local hit=3 read=3
                           ->  Bitmap Heap Scan on signal_message m  (cost=196.09..8199.96 rows=1 width=8) (actual rows=1 loops=1)
                                 Recheck Cond: ((md5(body) = '20732d8667266d5c51cb35484b3c15a8'::text) AND (NOT deleted))
                                 Filter: (body = '02.10.2026 10:16:00
 message 999991'::text)
                                 Heap Blocks: exact=1
                                 Buffers: local hit=1 read=3
                                 ->  Bitmap Index Scan on signal_message_active_body_fingerprint_idx  (cost=0.00..196.09 rows=4755 width=0) (actual rows=1 loops=1)
                                       Index Cond: (md5(body) = '20732d8667266d5c51cb35484b3c15a8'::text)
                                       Buffers: local read=3
                           ->  Index Scan using rer_csv_import_message_pkey on rer_csv_import_message p  (cost=0.29..8.30 rows=1 width=16) (actual rows=0 loops=1)
                                 Index Cond: (message_id = m.id)
                                 Buffers: local hit=2
                     ->  Index Only Scan using signal_message_group_group_master_key_signal_message_id_idx on signal_message_group g  (cost=0.42..8.45 rows=1 width=8) (actual rows=1 loops=1)
                           Index Cond: ((group_master_key = 'group-1'::text) AND (signal_message_id = m.id))
                           Heap Fetches: 1
                           Buffers: local read=4
         SubPlan 1
           ->  Index Only Scan using sigint_inbox_item_pkey on sigint_inbox_item i  (cost=0.42..8.44 rows=1 width=0) (actual rows=1 loops=1)
                 Index Cond: (id = m.id)
                 Heap Fetches: 1
                 Buffers: local read=4
 Planning:
   Buffers: local hit=22
 Planning Time: 0.195 ms
 Execution Time: 0.590 ms
(37 rows)

                                                                                       QUERY PLAN                                                                                       
----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=8224.74..8233.19 rows=1 width=11) (actual rows=0 loops=1)
   Buffers: local hit=1 read=2
   ->  Result  (cost=8224.74..8233.19 rows=1 width=11) (actual rows=0 loops=1)
         Buffers: local hit=1 read=2
         ->  Sort  (cost=8224.74..8224.74 rows=1 width=10) (actual rows=0 loops=1)
               Sort Key: m.id
               Sort Method: quicksort  Memory: 25kB
               Buffers: local hit=1 read=2
               ->  Nested Loop Semi Join  (cost=196.80..8224.73 rows=1 width=10) (actual rows=0 loops=1)
                     Buffers: local hit=1 read=2
                     ->  Nested Loop Left Join  (cost=196.37..8208.26 rows=1 width=24) (actual rows=0 loops=1)
                           Buffers: local hit=1 read=2
                           ->  Bitmap Heap Scan on signal_message m  (cost=196.09..8199.96 rows=1 width=8) (actual rows=0 loops=1)
                                 Recheck Cond: ((md5(body) = 'aaa005ae0b16c1a65c79abd4a0036270'::text) AND (NOT deleted))
                                 Filter: (body = 'missing CSV body'::text)
                                 Buffers: local hit=1 read=2
                                 ->  Bitmap Index Scan on signal_message_active_body_fingerprint_idx  (cost=0.00..196.09 rows=4755 width=0) (actual rows=0 loops=1)
                                       Index Cond: (md5(body) = 'aaa005ae0b16c1a65c79abd4a0036270'::text)
                                       Buffers: local hit=1 read=2
                           ->  Index Scan using rer_csv_import_message_pkey on rer_csv_import_message p  (cost=0.29..8.30 rows=1 width=16) (never executed)
                                 Index Cond: (message_id = m.id)
                     ->  Index Only Scan using signal_message_group_group_master_key_signal_message_id_idx on signal_message_group g  (cost=0.42..8.45 rows=1 width=8) (never executed)
                           Index Cond: ((group_master_key = 'group-1'::text) AND (signal_message_id = m.id))
                           Heap Fetches: 0
         SubPlan 1
           ->  Index Only Scan using sigint_inbox_item_pkey on sigint_inbox_item i  (cost=0.42..8.44 rows=1 width=0) (never executed)
                 Index Cond: (id = m.id)
                 Heap Fetches: 0
 Planning:
   Buffers: local hit=22
 Planning Time: 0.179 ms
 Execution Time: 0.043 ms
(32 rows)

```

## Processed-match priority and split-parent lookup

The updated migration indexes `(md5(body), id)` for all messages, so deleted
split parents use the same selective access path as active messages. The
previous active-only index cannot serve split-parent lookup. Maintenance now
hashes active and deleted message bodies; creation remains concurrent.

The updated SQL was taken directly from `persistence.rs` and measured on the
same synthetic cardinalities above, with saved child IDs in the 10,000 recovery
rows. Plain `EXPLAIN` was inspected before `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF,
SUMMARY ON)`. Both lookups used fingerprint indexes; the updated lookup also
used primary-key access for recovery state, children, and inboxes, plus indexed
group membership. Hits examined one body candidate, and the miss examined none.
No full message, recovery, inbox, or group scan occurred; sorts stayed in memory.

| Lookup | Execution time | Local buffers (hit/read) |
| --- | --- | --- |
| Previous lookup, active hit | 5.820 ms | 4/10 |
| Updated lookup, active hit | 1.556 ms | 7/7 |
| Updated lookup, tracked split-parent hit | 3.280 ms | 19/7 |
| Updated lookup, miss | 0.344 ms | 1/2 |

These single executions include different cache states and do not establish a
latency improvement. Candidate work still grows with identical bodies; saved
child checks are bounded by each candidate's durable inbox ID array. The
captured split-parent plan shows both the fingerprint lookup and child checks:

```text
 Limit  (cost=99.92..99.92 rows=1 width=11) (actual rows=1 loops=1)
   Buffers: local hit=19 read=7
   ->  Sort  (cost=99.92..99.92 rows=1 width=11) (actual rows=1 loops=1)
         Sort Key: ((p.completed_at IS NOT NULL)) DESC, ((SubPlan 1)) DESC, ((p.message_id IS NOT NULL)), m.id
         Sort Method: quicksort  Memory: 25kB
         Buffers: local hit=19 read=7
         ->  Nested Loop Semi Join  (cost=1.14..99.91 rows=1 width=11) (actual rows=1 loops=1)
               Buffers: local hit=19 read=7
               ->  Nested Loop Left Join  (cost=0.71..30.81 rows=1 width=53) (actual rows=1 loops=1)
                     Filter: ((NOT m.deleted) OR (SubPlan 2))
                     Buffers: local hit=11 read=4
                     ->  Index Scan using signal_message_body_fingerprint_idx on signal_message m  (cost=0.42..8.45 rows=1 width=9) (actual rows=1 loops=1)
                           Index Cond: (md5(body) = '2f0daaf45e6c6a3641e96c305c626f39'::text)
                           Filter: (body = '02.10.2026 10:16:00
 message 1'::text)
                           Buffers: local hit=2 read=2
                     ->  Index Scan using rer_csv_import_message_pkey on rer_csv_import_message p  (cost=0.29..8.30 rows=1 width=45) (actual rows=1 loops=1)
                           Index Cond: (message_id = m.id)
                           Buffers: local hit=3
                     SubPlan 2
                       ->  Nested Loop  (cost=0.85..132.88 rows=10 width=0) (actual rows=1 loops=1)
                             Buffers: local hit=6 read=2
                             ->  Index Scan using signal_message_pkey on signal_message child  (cost=0.42..48.45 rows=10 width=8) (actual rows=1 loops=1)
                                   Index Cond: (id = ANY (p.inbox_item_ids))
                                   Filter: ((NOT deleted) AND (id <> m.id))
                                   Buffers: local hit=2 read=2
                             ->  Index Only Scan using sigint_inbox_item_pkey on sigint_inbox_item i_1  (cost=0.42..8.44 rows=1 width=8) (actual rows=1 loops=1)
                                   Index Cond: (id = child.id)
                                   Heap Fetches: 1
                                   Buffers: local hit=4
               ->  Index Only Scan using signal_message_group_group_master_key_signal_message_id_idx on signal_message_group g  (cost=0.42..8.45 rows=1 width=8) (actual rows=1 loops=1)
                     Index Cond: ((group_master_key = 'group-1'::text) AND (signal_message_id = m.id))
                     Heap Fetches: 1
                     Buffers: local hit=1 read=3
               SubPlan 1
                 ->  Bitmap Heap Scan on sigint_inbox_item i  (cost=48.76..91.35 rows=11 width=0) (actual rows=1 loops=1)
                       Recheck Cond: ((id = m.id) OR (id = ANY (p.inbox_item_ids)))
                       Heap Blocks: exact=1
                       Buffers: local hit=7
                       ->  BitmapOr  (cost=48.76..48.76 rows=11 width=0) (actual rows=0 loops=1)
                             Buffers: local hit=6
                             ->  Bitmap Index Scan on sigint_inbox_item_pkey  (cost=0.00..4.43 rows=1 width=0) (actual rows=0 loops=1)
                                   Index Cond: (id = m.id)
                                   Buffers: local hit=3
                             ->  Bitmap Index Scan on sigint_inbox_item_pkey  (cost=0.00..44.33 rows=10 width=0) (actual rows=1 loops=1)
                                   Index Cond: (id = ANY (p.inbox_item_ids))
                                   Buffers: local hit=3
 Planning:
   Buffers: local hit=34
 Planning Time: 0.493 ms
 Execution Time: 3.280 ms
(51 rows)
```
