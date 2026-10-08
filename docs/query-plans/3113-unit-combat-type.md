# SIGINT combat-type query plans (#3113)

Measured on local PostgreSQL 14 with `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF,
SUMMARY ON)` and a 30-second statement timeout. Temporary copies of the
application tables and their indexes held 100,000 SIGINT units, 100,000 ORBIT
units, one link per unit, and 20 combat types. Ten percent of SIGINT assignments
were null; one percent of ORBIT units were deleted and one percent of links were
suppressed. Tables were analyzed before measurement. This is synthetic scale
evidence, not a measurement of a live deployment's data distribution or latency.

The list page uses the production left join and `coalesce(dictionary.name, '')`
sort with a unit-ID tie breaker. Sorting 50 results took 66.190 ms and used a
36 kB top-N heap. The name-filtered variant took 167.964 ms and retained 5,000
matching units; both scanned the full unit relation and hashed 20 dictionary
rows without per-unit dictionary lookups. Their whole-table sort/filter cost
remains proportional to the number of eligible units, as with existing text
column sorts; no new speculative index is introduced.

The production backfill batch query after ID 90,000 took 1.545 ms. The primary
unit index started at `id > 90000`, read 103 candidate unit rows to obtain 100
eligible rows, and sought links through `orbit_unit_sigint_unit_sigint_unit_id_idx`
and ORBIT units through their primary keys. It did not restart scans before the
cursor or aggregate the complete link relation. Per-unit rechecks use the same
indexed link ID and ORBIT primary key; source rechecks and changed-unit writes
hold only one transaction at a time.

## Sorted list page, 100000 SIGINT units / 20 types

```text
QUERY PLAN                                                           
--------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=6152.00..6152.12 rows=50 width=198) (actual rows=50 loops=1)
   Buffers: local hit=1 read=1516 written=1015
   ->  Sort  (cost=6152.00..6402.00 rows=100000 width=198) (actual rows=50 loops=1)
         Sort Key: (COALESCE(sigint_unit_orbit_combat_type.name, ''::text)), sigint_unit.id
         Sort Method: top-N heapsort  Memory: 36kB
         Buffers: local hit=1 read=1516 written=1015
         ->  Hash Left Join  (cost=1.45..2830.07 rows=100000 width=198) (actual rows=100000 loops=1)
               Hash Cond: (sigint_unit.combat_type_id = sigint_unit_orbit_combat_type.id)
               Buffers: local hit=1 read=1516 written=1015
               ->  Seq Scan on sigint_unit  (cost=0.00..2516.00 rows=100000 width=166) (actual rows=100000 loops=1)
                     Filter: ((NOT deleted) AND active)
                     Buffers: local read=1516 written=1015
               ->  Hash  (cost=1.20..1.20 rows=20 width=24) (actual rows=20 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 10kB
                     Buffers: local hit=1
                     ->  Seq Scan on sigint_unit_orbit_combat_type  (cost=0.00..1.20 rows=20 width=24) (actual rows=20 loops=1)
                           Buffers: local hit=1
 Planning:
   Buffers: shared hit=228 read=2, local hit=2 read=9 written=9
 Planning Time: 2.970 ms
 Execution Time: 66.190 ms
(21 rows)
```

## Filtered and sorted list page

```text
QUERY PLAN                                                                                        
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=2864.02..2864.05 rows=10 width=198) (actual rows=50 loops=1)
   Buffers: local hit=1 read=1516
   ->  Sort  (cost=2864.02..2864.05 rows=10 width=198) (actual rows=50 loops=1)
         Sort Key: (COALESCE(sigint_unit_orbit_combat_type.name, ''::text)), sigint_unit.id
         Sort Method: top-N heapsort  Memory: 32kB
         Buffers: local hit=1 read=1516
         ->  Hash Left Join  (cost=1.45..2863.86 rows=10 width=198) (actual rows=5000 loops=1)
               Hash Cond: (sigint_unit.combat_type_id = sigint_unit_orbit_combat_type.id)
               Filter: (regexp_replace(lower((COALESCE(sigint_unit_orbit_combat_type.name, ''::text))::text), '[[:punct:][:space:]]+'::text, ' '::text, 'g'::text) ~~* '%type 02%'::text)
               Rows Removed by Filter: 95000
               Buffers: local hit=1 read=1516
               ->  Seq Scan on sigint_unit  (cost=0.00..2516.00 rows=100000 width=166) (actual rows=100000 loops=1)
                     Filter: ((NOT deleted) AND active)
                     Buffers: local read=1516
               ->  Hash  (cost=1.20..1.20 rows=20 width=24) (actual rows=20 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 10kB
                     Buffers: local hit=1
                     ->  Seq Scan on sigint_unit_orbit_combat_type  (cost=0.00..1.20 rows=20 width=24) (actual rows=20 loops=1)
                           Buffers: local hit=1
 Planning:
   Buffers: shared hit=1 read=3, local hit=4 read=1
 Planning Time: 14.061 ms
 Execution Time: 167.964 ms
(23 rows)
```

## Backfill batch after ID 90000

```text
QUERY PLAN                                                                                     
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 GroupAggregate  (cost=934.69..936.90 rows=98 width=56) (actual rows=100 loops=1)
   Group Key: candidates.id, candidates.combat_type_id
   Buffers: shared hit=3, local hit=1318 read=101
   CTE candidates
     ->  Limit  (cost=1.00..131.27 rows=100 width=24) (actual rows=100 loops=1)
           Buffers: shared hit=3, local hit=618 read=101
           ->  Nested Loop Semi Join  (cost=1.00..12718.80 rows=9763 width=24) (actual rows=100 loops=1)
                 Buffers: shared hit=3, local hit=618 read=101
                 ->  Index Scan using sigint_unit_pkey on sigint_unit unit  (cost=0.29..440.47 rows=9953 width=24) (actual rows=103 loops=1)
                       Index Cond: (id > 90000)
                       Filter: (NOT deleted)
                       Buffers: shared hit=3, local hit=4 read=2
                 ->  Nested Loop  (cost=0.71..1.22 rows=1 width=8) (actual rows=1 loops=103)
                       Buffers: local hit=614 read=99
                       ->  Index Scan using orbit_unit_sigint_unit_sigint_unit_id_idx on orbit_unit_sigint_unit link_1  (cost=0.29..0.72 rows=1 width=24) (actual rows=1 loops=103)
                             Index Cond: (sigint_unit_id = unit.id)
                             Filter: (NOT is_suppressed)
                             Rows Removed by Filter: 0
                             Buffers: local hit=305 read=4
                       ->  Index Scan using orbit_unit_pkey on orbit_unit orbit_1  (cost=0.42..0.51 rows=1 width=16) (actual rows=1 loops=101)
                             Index Cond: (unit_id = link_1.orbit_unit_id)
                             Filter: (NOT deleted)
                             Rows Removed by Filter: 0
                             Buffers: local hit=309 read=95
   ->  Sort  (cost=803.43..803.67 rows=98 width=40) (actual rows=100 loops=1)
         Sort Key: candidates.id, candidates.combat_type_id
         Sort Method: quicksort  Memory: 32kB
         Buffers: shared hit=3, local hit=1318 read=101
         ->  Nested Loop  (cost=0.71..800.18 rows=98 width=40) (actual rows=100 loops=1)
               Buffers: shared hit=3, local hit=1318 read=101
               ->  Nested Loop  (cost=0.29..750.00 rows=99 width=40) (actual rows=100 loops=1)
                     Buffers: shared hit=3, local hit=918 read=101
                     ->  CTE Scan on candidates  (cost=0.00..2.00 rows=100 width=24) (actual rows=100 loops=1)
                           Buffers: shared hit=3, local hit=618 read=101
                     ->  Index Scan using orbit_unit_sigint_unit_sigint_unit_id_idx on orbit_unit_sigint_unit link  (cost=0.29..7.47 rows=1 width=24) (actual rows=1 loops=100)
                           Index Cond: (sigint_unit_id = candidates.id)
                           Filter: (NOT is_suppressed)
                           Buffers: local hit=300
               ->  Index Scan using orbit_unit_pkey on orbit_unit orbit  (cost=0.42..0.51 rows=1 width=32) (actual rows=1 loops=100)
                     Index Cond: (unit_id = link.orbit_unit_id)
                     Filter: (NOT deleted)
                     Buffers: local hit=400
 Planning:
   Buffers: shared hit=104, local hit=23 read=32
 Planning Time: 2.131 ms
 Execution Time: 1.545 ms
(46 rows)
```

## Initial eligible-unit count

The progress estimate counts eligible units once before processing. This query
scanned the 100,000-row relations in 63.855 ms, counted 98,000 eligible units,
and used two-batch hashes with 824 temporary pages (about 6.4 MiB). This
one-time scan does not run per batch or per unit; remaining work and time are
estimates if source links change during the action.

```text
 Aggregate  (cost=14481.60..14481.61 rows=1 width=8) (actual rows=1 loops=1)
   Buffers: local hit=3 read=3484 written=991, temp read=824 written=824
   ->  Hash Semi Join  (cost=9203.43..14236.71 rows=97958 width=0) (actual rows=98000 loops=1)
         Hash Cond: (unit.id = link.sigint_unit_id)
         Buffers: local hit=3 read=3484 written=991, temp read=824 written=824
         ->  Seq Scan on sigint_unit unit  (cost=0.00..2516.00 rows=100000 width=8) (actual rows=100000 loops=1)
               Filter: (NOT deleted)
               Buffers: local hit=1 read=1515 written=1
         ->  Hash  (cost=7595.95..7595.95 rows=97958 width=8) (actual rows=98000 loops=1)
               Buckets: 131072  Batches: 2  Memory Usage: 2938kB
               Buffers: local hit=2 read=1969 written=990, temp read=484 written=651
               ->  Hash Join  (cost=3956.12..7595.95 rows=97958 width=8) (actual rows=98000 loops=1)
                     Hash Cond: (link.orbit_unit_id = orbit.unit_id)
                     Buffers: local hit=2 read=1969 written=990, temp read=484 written=484
                     ->  Seq Scan on orbit_unit_sigint_unit link  (cost=0.00..1736.00 rows=98977 width=24) (actual rows=99000 loops=1)
                           Filter: (NOT is_suppressed)
                           Rows Removed by Filter: 1000
                           Buffers: local hit=1 read=735 written=2
                     ->  Hash  (cost=2235.00..2235.00 rows=98970 width=16) (actual rows=99000 loops=1)
                           Buckets: 131072  Batches: 2  Memory Usage: 3349kB
                           Buffers: local hit=1 read=1234 written=988, temp written=217
                           ->  Seq Scan on orbit_unit orbit  (cost=0.00..2235.00 rows=98970 width=16) (actual rows=99000 loops=1)
                                 Filter: (NOT deleted)
                                 Rows Removed by Filter: 1000
                                 Buffers: local hit=1 read=1234 written=988
 Planning:
   Buffers: shared hit=251 read=3, local hit=9 read=33 written=33
 Planning Time: 1.176 ms
 Execution Time: 63.855 ms
```
