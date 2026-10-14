# Search routing and bounded detail loading (#3780)

Text searches attempt the existing PostgreSQL-compatible analytics gateway.
Errors, timeouts, stale replication health, incomplete attachment coverage, and
failed source revalidation use PostgreSQL fallback. Authorization and message
details remain authoritative on PostgreSQL. Analytics and bounded source
revalidation use correlated `EXISTS` per text source so the gateway can push
text predicates into ClickHouse together with ordering and the page limit.

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

After the CDC-only mapping is running, reconciliation records the source UTC
cutover in the gateway-local `public.echo_analytics_attachment_search` table.
`history_complete=false` is retained until the historical oneoff succeeds.
When metadata is absent, search falls back safely.

Before querying analytics, the application checks older source attachment
chunks for any search term, including quoted and negative terms. It also checks
messages with attachment documents changed within the replication freshness
window against the complete current text predicate. This includes negative
searches after a term was removed. Matching requests use PostgreSQL for the
complete operation. This is conservative: a match outside the requested groups
or period can also cause fallback. Older attachment matches remain available
without copying history automatically or combining incomplete negative
predicates. Other text searches can use analytics with new-only replication.

Body, filename, attachment-content, frequency, UID, prefix, quoted, and negative
search semantics are unchanged. Existing freshness checks, source tails,
revalidation, ordering, and fallback capacity controls remain in place.

## Rollout and historical oneoff

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
holds the shared reconciliation lock, marks history incomplete, and forces a
targeted snapshot of documents followed by chunks. Only those two raw tables
and their views are replaced; source attachment data is preserved. Existing
targeted-resnapshot state tracks interruption and recovery. Health verification
must pass before history is marked complete. The command can temporarily
increase source reads and retained WAL; its progress is logged per table.

If it fails, retain `history_complete=false`, inspect the reported mirror/state
error, and rerun the same command after correcting it before another deployment.
Deployment refuses unresolved targeted snapshot state. Do not mark history
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
