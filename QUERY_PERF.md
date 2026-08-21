# Query performance review

Use this guide when reviewing new or changed PostgreSQL or ClickHouse queries,
especially background jobs, oneoffs, analytics, search, pagination, and queries
over large tables. ORM-generated SQL needs the same review as handwritten SQL.

## Identify high-risk queries

Require performance evidence when a query can scan a large table, runs once per
item or batch, joins large relations, sorts or aggregates many rows, serves an
interactive request, or is expected to run repeatedly for hours. Development
data is not sufficient evidence when production cardinality or data
distribution materially changes the plan.

## Make pagination seekable

Prefer keyset pagination with a stable, unique order. The page boundary must be
usable as an index condition by every large relation that participates in the
ordered join, even when a predicate appears logically redundant.

For example, given `left.id = right.id` and `left.id > $cursor`, PostgreSQL may
still scan `right` from its beginning. Add `right.id > $cursor` when it lets the
planner seek into the joined index. For composite ordering, use the matching
tuple boundary and deterministic tie-breaker. Reject offset pagination over
large or continuously changing result sets.

## Fetch and process only what is needed

- Project only the columns used by the caller; do not load a full ORM entity by
  default when a narrow projection is enough.
- Avoid N+1 queries and per-row correlated work when it can be performed in a
  bounded set-based query.
- Keep batches bounded by rows and practical memory size. Make long-running
  jobs resumable, idempotent, observable, and safe to cancel between batches.
- Record a monotonic cursor, processed count, rate, and estimated remaining
  work. A job that is moving can still be operationally unacceptable.

## Align predicates, ordering, and indexes

Check that selective predicates and `ORDER BY` can use the same useful index,
including column order and sort direction. A condition shown only as `Filter`
may still require reading many rows; important seek conditions should normally
appear under `Index Cond`. Do not add an index without considering write cost,
table size, replication impact, and the migration rules in `AGENTS.md`.

Pay particular attention to:

- joins where an inequality or time bound is applied to only one side;
- broad time ranges combined with ordering by a different key;
- `SELECT *`, wide or toasted columns, and large `IN` lists;
- sorts, hashes, or aggregates that spill to temporary storage;
- nested loops with a high outer row count;
- estimates that differ greatly from actual rows.

## Validate the actual plan

For a read query, use representative parameters and production-scale data with:

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)
SELECT ...;
```

Set a defensive `statement_timeout` before testing on a live database. Never
run `EXPLAIN ANALYZE` on a data-changing statement in production. Use plain
`EXPLAIN` first when the query might be expensive.

Review execution time, actual rows and loops, buffer reads, temporary I/O,
rows removed by filters, index conditions, and where scans begin. Compare the
old and new plans; a lower estimated cost alone is not proof of improvement.

## Verify sustained behavior

Use slow logs and short `pg_stat_statements` deltas to attribute production
load by query ID. Compare calls, total and mean execution time, shared blocks
read, and temporary blocks before and after the change. For ClickHouse, inspect
`system.query_log`, read rows and bytes, memory, spills, and background merge or
mutation pressure.

A review is complete when the query has a bounded access path, representative
plan evidence, and an operational story for progress, cancellation, and
recovery where applicable.
