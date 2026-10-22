# AOR and duplicate-link performance fixes (#3780)

This is the first independently deployable batch from the
[Pivnich/Skhid performance plan](../../archive/2026-10-12-perf/iteration1/fix.md).
See the [incident evidence](../../archive/2026-10-12-perf/iteration1/perf.md) and
[implementation measurements](../../archive/2026-10-12-perf/iteration1/implementation.md).

## Behavior

Analytics AOR facets first produce eligible message IDs, then use membership
against the derived message/AOR links. Per-AOR values still count distinct
messages. The count-only endpoint counts distinct AOR IDs directly instead of
computing every per-AOR message count and fetching all rows.

The eligible-message query retains authorization, deletion, timestamp basis,
inclusive/exclusive dates, selected filters, and own-facet-filter removal.
Message-ID bounds constrain both candidates and links. Recent scopes remain
lower-bound-only. A post join is included when a post filter is present,
including the empty-post selection. Derived current-row handling, freshness
checks, and PostgreSQL fallback remain at their existing boundaries.

Duplicate-link reconciliation now selects the group-link ID and message ID.
The equality lookup uses a new PostgreSQL btree index on
`(datasource_group_id, created_at, sender) INCLUDE (id, signal_message_id)`.
Null senders retain `IS NULL` matching. The lookup reads at most two candidates;
multiple matches retain the safeguard that skips deletion, and the logged match
count is a lower bound. Successful reconciliation still requeues settlements for
the affected original message inside the existing transaction.

## Migration and release

This batch was transferred into the main-based `3780-aor-perf` branch after
validation on stable. Review and validate the current branch against `main`,
including the catalog-aware migration check with `GITHUB_BASE_REF=main`.
Do not rebase or change its base without an explicit user instruction.

Migration:
`m20261012_082021_signal_message_group_duplicate_lookup_index`.
Its `up` and `down` use concurrent index operations and explicitly disable the
migration transaction. Do not wrap the migration runner in an external
transaction. This index-only change declares no replicated catalog impact;
it requires no PeerDB backfill or mirror resync. Entity definitions are unchanged.

Before release on each deployment:

1. Check free space, concurrent index-build activity, long-running transactions,
   source replication lag, and ingest latency. The synthetic 38.8-million-row
   benchmark index occupied 3,309 MiB; actual production sender distribution and
   concurrent build temporary space can change the requirement substantially.
2. Run the normal release/migration procedure in a suitable build window. Track
   `pg_stat_progress_create_index` and PostgreSQL wait events. Concurrent builds
   permit ordinary writes but still consume I/O, CPU, space, and WAL and can wait
   for old transactions. Measure build/write costs before wider rollout.
3. Verify the index is ready and valid and the migration record exists:

~~~sql
SELECT indexrelid::regclass AS index_name, indisready, indisvalid,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_index
WHERE indexrelid = to_regclass(
    'public.signal_message_group_duplicate_lookup_idx'
);

SELECT version FROM seaql_migrations
WHERE version = 'm20261012_082021_signal_message_group_duplicate_lookup_index';
~~~

4. Verify analytics health and replication freshness. Canary the application
   query change on Pivnich, then compare matched workload windows before Skhid.
   Include ordinary Duty traffic and broad historical filters alongside AOR
   requests. Observe at least 30–60 minutes and a later peak period.

Track AOR normalized fingerprints, completed/failed requests, memory/read
rows/time, circuit and fallback reasons, PostgreSQL timeout counts, duplicate
lookup reads/time, ingestion latency, source-slot lag, and container PSI.
The bounded read-only AOR diagnostics used an 8-second execution limit and
2-GiB per-query cap; these were diagnostic settings, not a deployed resource
profile. Production concurrency and p95 acceptance remain canary gates.

## Recovery

Revert the application binary if results differ or common reads regress. The
added index can remain while the query change is reverted.

If a concurrent build fails, inspect index readiness/validity, current build
activity, and the migration record before retrying. A failed build can leave
an invalid index that blocks another `CREATE INDEX` with the same name. Once
the failed build has ended, remove that invalid index with a standalone
`DROP INDEX CONCURRENTLY public.signal_message_group_duplicate_lookup_idx`,
then retry the normal migration runner. Do not drop an active or useful valid
index as part of automatic recovery, and do not manually delete migration
records during routine rollout.

An interruption after index creation but before recording the migration needs
operator reconciliation of the valid definition and migration state. Do not
treat the duplicate-name error as proof that the migration completed.

The migration's `down` drops this index concurrently. Rollback on a test
database first; production removal restores the expensive lookup path and
requires an explicit operational decision.

## Remaining work

Search scoping and heavy-query admission, ClickHouse resource profiles,
network last-seen recalculation, OCR rank reuse, redirects, and secondary
maintenance remain separate batches in the approved plan. In particular,
text-search requests still use PostgreSQL: this batch does not establish
resolution of all timeout-derived 503s.
