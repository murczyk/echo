# Search routing and bounded detail loading (#3780)

Supported text searches attempt the existing PostgreSQL-compatible analytics gateway.
Errors, timeouts, stale replication health, incomplete attachment coverage, and
failed source revalidation use PostgreSQL fallback. Authorization and message
details remain authoritative on PostgreSQL. Analytics and bounded source
revalidation use correlated `EXISTS` per text source so the gateway can push
text predicates into ClickHouse together with ordering and the page limit.
Quoted Fuzzy predicates use the source until complete gateway pushdown is
supported. Source quoted-body matching reads the already joined inbox JSON
field; attachment and negative-term semantics remain unchanged.

The paginated PostgreSQL path selects only message IDs and ordering keys, with
all search/access/facet/cursor predicates and the existing page limit. It then
loads details, tags, and metadata for those IDs in the same short read-only
repeatable-read transaction. The transaction ends before secondary enrichment.
Unlimited reads keep their existing behavior. This prevents the planner from
aggregating tags and metadata for the entire requested period before filtering.

## Attachment coverage

`attachment_document` and `attachment_chunk` are included in the publication
and registered as CDC-only tables. Ordinary table additions and initial mirror
bootstrap do not copy their historical rows. Settings and worker jobs stay
excluded. The pinned PeerDB v0.37.1 supports
[`skipInitialSnapshotForTableAdditions`](https://github.com/PeerDB-io/peerdb/blob/1f84ed1987c002cae9b9d9bbc4f159f42b4c8fe2/flow/workflows/cdc_flow.go#L283).
Ordinary snapshot additions are submitted separately so that this flag cannot
suppress another table's initial load.

The existing source publication enables PostgreSQL 18's
[`publish_generated_columns=stored`](https://www.postgresql.org/docs/18/logical-replication-gencols.html),
which also publishes the stored attachment search vector; verify it in the raw
table and gateway after a new attachment is processed.

Reconciliation compares the desired tables with PeerDB's actual mappings,
verifies the resulting mappings, and clears attachment coverage before repairing
mapping drift. Unmapped raw tables and missing mapped raw tables stop ordinary
reconciliation for explicit recovery instead of issuing duplicate additions.
After the CDC-only mapping and schema reconciliation succeed, it records the
source UTC cutover in the gateway-local `public.echo_analytics_attachment_search`
table.
`history_complete=false` is retained until the historical oneoff succeeds.
When metadata is absent, search falls back safely.

Before querying analytics, the application checks older source attachment
chunks for any search term, including negative terms. Incomplete historical
coverage retains the conservative source fallback, including matches outside
the requested groups or dates.

Migration `m20261015_184629_attachment_search_message_change` adds a source-only
changed-message ledger. Searchable chunk/revision changes and media
insert/rename/move/delete record old and new owners; tombstones survive deletion.
Processing-only document updates do not dirty search. Changes initially have
`changed_at = NULL` and cannot expire. The extract worker observes up to 500
committed changes per minute and starts their freshness window at observation;
another mutation clears the timestamp again. This preserves changes from
transactions that remain open longer than the freshness window. After one complete
replication freshness window of tracking, at most 1,001 pending or recent IDs are read.
More than 1,000 forces full source fallback. Otherwise, relevant changes are
checked against the request's dates and permitted groups in both source and
analytics rows. Checking both catches newly imported backdated messages and
stale former owners without depending on analytics ID optimization bounds.
Relevant changes use PostgreSQL for the complete operation; unrelated changes
allow analytics. Results/counts are not merged between databases.

Initial tracking and freshness windows exceeding the ledger's 24-hour retention
force source fallback. The old singleton `attachment_search_change` remains
maintained for backend rollback compatibility. After observing changes, the extract
worker removes at most 500 entries older than 24 hours plus the 60-second request
deadline every minute; pending changes are never pruned. The extra interval
protects active requests using the maximum freshness window. Locked tuples are
deleted directly, keeping cleanup seeks bounded even with a large expired backlog.
Both tracking tables stay excluded from CDC.
History coverage and replication health checks remain required. Coverage logs
distinguish `tracking_incomplete`, `retention_window`, `history_incomplete`,
`change_limit` and `recent_message_change`.

Body, filename, attachment-content, frequency, UID, prefix, quoted, and negative
search semantics are unchanged. Existing freshness checks, source tails,
revalidation, ordering, and fallback capacity controls remain in place.

## Rollout and historical oneoff

For the scoped guard, sync packaged analytics exclusions before applying
`m20261015_184629_attachment_search_message_change` through normal deployment.
No replicated columns change and no mirror/history rebuild is required. Wait
the configured freshness window (currently 90 seconds), then compare source
and analytics for edits, removed/negative terms, moves and deletions across
groups/dates. Revert the backend before rolling back the migration; retaining
the schema during a backend rollback is safe because the old guard stays
maintained. See the [stabilization rollout](../../archive/2026-10-12-perf/iteration5/plan.md#rollout-and-recovery).

Before applying `m20261014_124732_attachment_document_updated_at_index`, check
available disk space and long-running transactions on the source. Its concurrent
index build keeps writes available; it changes no replicated columns and needs
no ClickHouse resnapshot. If interrupted, inspect `pg_index.indisvalid` for
`public.attachment_document_updated_at_idx`. If that index is invalid, run
`DROP INDEX CONCURRENTLY public.attachment_document_updated_at_idx` outside a
transaction and retry migrations. The timestamp-leading index bounds the
recent-change probe independently of document state. The probe reads the newest
timestamp before comparing the cutoff, preserving its bounded seek with generic
prepared plans.

Apply `m20261014_140818_attachment_chunk_summary_index` with the same disk-space
and long-transaction checks. Its concurrent GIN trigram index on
`attachment_chunk.summary` completes the indexed `text`/`member`/`summary`
substring predicate used by both positive and negative quoted coverage probes.
It changes no replicated columns and needs no ClickHouse resnapshot. If the
build is interrupted, inspect `pg_index.indisvalid` for
`public.attachment_chunk_summary_idx`; drop an invalid index with
`DROP INDEX CONCURRENTLY public.attachment_chunk_summary_idx` outside a
transaction before retrying migrations. The index adds source disk usage and
write overhead when chunk summaries change.

1. Deploy the matching source and analytics control bundles through the normal
   Echo deployment workflow. Their release IDs must agree.
2. Run `/opt/echo-peerdb/bin/source-sync-exclusions.sh --yes` on the source if
   deployment has not already reconciled table selection. Verify both attachment
   tables in the publication, raw ClickHouse tables, current views, and gateway;
   verify that the mirror is running and analytics health is fresh. After a new
   mirror's initial snapshot, run table reconciliation to add its CDC-only tables.
3. Check `started_at` and `history_complete` in
   `public.echo_analytics_attachment_search`. The initial value is false. Confirm
   that an old attachment match still appears through PostgreSQL fallback.
4. Compare source and analytical IDs/counts for representative body, filename,
   quoted, negative, and mixed body/attachment searches before expanding rollout.

Copy historical attachments only when explicitly requested:

```bash
just oneoff-replicate-attachment-history --server echo-pivnich
```

Or run on the source host:

```bash
wdintel-rs --mode=live oneoff-replicate-historical-attachments
```

The command delegates to the paired analytics host with the release handshake,
holds the shared reconciliation lock, clears coverage, and forces a
targeted snapshot of documents followed by chunks. Only those two raw tables
and their views are replaced; source attachment data is preserved. Existing
targeted-resnapshot state tracks interruption and recovery. Health verification
must pass before history is marked complete. The command can temporarily
increase source reads and retained WAL; its progress is logged per table.

If it fails, leave the coverage row absent, inspect the reported mirror/state
error, and rerun the same command after correcting it before another deployment.
Forced-copy intent is preserved in retry state; automatic deployment repairs
refuse this state and direct recovery still performs the requested copy.
The explicit oneoff also repairs a missing attachment raw table. Ordinary
reconciliation restores `history_complete=false` after successful recovery;
only the historical oneoff can set it to true. Do not mark history
complete manually. A paused mirror requires prompt recovery because WAL remains
retained. To roll back application routing, deploy the prior backend; source
history and CDC data remain available.

## Verification

Run the #3780 database regressions for paginated search and attachment coverage,
the existing authorization/tag/metadata and analytics-fallback tests, and the
Analysis/Duty browser regressions. Deployment tests cover mixed ordinary and
CDC-only additions, failure before coverage publication, and forced historical
snapshot despite matching schemas.

On production-scale data, use plain `EXPLAIN` first, then bounded read-only
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` for 1-, 7-, 8-, 16-, and
31-day searches and later pages. Verify that detail aggregates run once per
selected ID. Use gateway `EXPLAIN (VERBOSE)` to verify full predicate pushdown,
including attachment joins, rather than relying on gateway connectivity alone.

The initial Pivnich investigation observed repeated 30-second cancellations.
For one 16-day query, narrow ID selection took 766 ms and details for its 20 IDs
took 18 ms. Repeating all search predicates during hydration took 2.61 s;
correlating text predicates to the same bounded IDs reduced this to 63 ms.
A read-only gateway diagnostic for body/filename search returned 20 IDs for
that period in 1.11 s, with filtering, ordering, and limit in one foreign scan.
The full attachment predicate also planned as one foreign scan in an isolated
gateway with the deployed FDW; executing it requires the new attachment tables
to be deployed. Wrapping the original full-row query or merely adding an ID
CTE did not remove its slow plan. These are diagnostic SQL timings, not an
end-to-end SLA.

The seven-day count-query strategy switch remains separate from detail loading.
Compare count plans on both sides of that boundary before changing it.
PostgreSQL candidate text-search union deduplication and quoted substring
predicates also need representative plan evidence before further optimization.

## Analysis search modes

`search_mode` is optional on analysis, inbox, and callsign-graph requests.
Absent, null, and `Fuzzy` retain the original search behavior. `Exact` uses
case-insensitive word-boundary regular expressions; `Substring` uses escaped
case-insensitive literal patterns. Operators and structured frequency/UID
filters remain available. Saved filters and both Analysis URLs retain the mode.
The user contract is [Analysis search](../content/analysis-search.md#режими-пошуку).

Nonempty exact and substring searches use PostgreSQL. Gateway plans on
`echo-kharkiv2` showed local literal-body filtering through the JSON compatibility
views, including an unbounded foreign-table read for the self-correlated regex
shape. These modes therefore apply body predicates directly to the already
filtered inbox relation and do not attempt that gateway path. Fuzzy routing is
unchanged. Read-only unit-count diagnostics with the incident's group scope and
`нора` took 66 ms for one day and 3.68 s for 30 days on 15 October 2026; the
30-day plan still scanned large joined relations and spilled temporary data.
These isolated timings do not establish a latency guarantee under concurrency
or resolve the separate PostgreSQL count-query performance issue.
