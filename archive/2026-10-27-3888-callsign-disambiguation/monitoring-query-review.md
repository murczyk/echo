# AI monitoring query review

Local PostgreSQL 14 plan evidence for #3888, 2026-10-27. No production changes
or production message contents were used. The fixture in `monitoring_perf.rs`
creates temporary tables inside the dedicated restored test database, with
2,000,000 jobs and 2,000,000 memberships. It uses the queue creation-time index
added by the migration and the existing membership indexes. Each query has a
30-second statement timeout. Full `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF,
SUMMARY ON)` results are in `monitoring-query-plans.txt`.

| Lookup | Execution time | Access |
| --- | --- | --- |
| Unrestricted oldest job | 0.062 ms | Creation-time index, one row, four buffers |
| Only a group present in the newest 1,000 jobs | 1,037 ms | Ordered queue index plus 1,999,001 indexed membership probes |
| Except a group present in the oldest 1,999,000 jobs | 1,161 ms | Ordered queue index plus 1,999,001 indexed membership probes |
| Only a group with no memberships | 0.129 ms | Membership index; queue lookup never executed |

Exact eligibility under settlement group restrictions can inspect excluded
history. AI snapshots therefore have a shared 60-second cache; concurrent
polls reuse the snapshot instead of issuing repeated eligibility scans. The
existing five-second endpoint response cache remains. Queue depth comes from
PostgreSQL estimates rather than `COUNT(*)`; unrestricted oldest-job queries
are indexed. The estimate can include excluded jobs, so alerting uses eligible
pending timestamps, not an estimated count as an emptiness check.

These are synthetic local plans at the incident's queue cardinality, not a
production latency guarantee. Recheck query plans and load if backlog size,
group distribution, or indexes change materially.
