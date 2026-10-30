# Search routing and bounded detail loading (#3780)

Supported text searches attempt the existing PostgreSQL-compatible analytics gateway.
Errors, timeouts, stale replication health, incomplete attachment coverage, and
failed source revalidation use PostgreSQL fallback. Authorization and message
details remain authoritative on PostgreSQL. Analytics and bounded source
revalidation use correlated `EXISTS` per text source so the gateway can push
text predicates into ClickHouse together with ordering and the page limit.
Quoted Fuzzy, Exact and Substring predicates use the source until complete
gateway pushdown is supported. Source quoted-body matching reads the already joined inbox JSON
field; attachment and negative-term semantics remain unchanged.

Correlated source reads parse each tsquery once through a scalar subquery.
Analytics reads keep the same expression inline: a gateway initplan prevents
native text filtering and can fetch the whole search table. Correlation and
tsquery placement are separate choices. Analytics pools retain their existing
`force_custom_plan` setting so bound search terms can become native predicates.

The paginated PostgreSQL path selects only message IDs and ordering keys, with
all search/access/facet/cursor predicates and the existing page limit. It then
loads details, tags, and metadata for those IDs in the same short read-only
repeatable-read transaction. The transaction ends before secondary enrichment.
Unlimited reads keep their existing behavior. This prevents the planner from
aggregating tags and metadata for the entire requested period before filtering.

Source inbox pages using indexed Fuzzy match sets allow PostgreSQL to reorder
the message/inbox join. Forcing a date-first lateral message lookup can place
global text-match aggregation inside the per-message loop. Correlated,
date-scoped, literal and non-text reads retain their existing join strategy.

PostgreSQL fresh-tail pages and counts correlate text predicates to the outer
message IDs, including filename and attachment branches. Their creation-time
lower bound limits candidate messages before text checks; they do not construct
a search-match union across the entire history. Full-period PostgreSQL reads
start with indexed match sets; the bounded complex-search and historical-count
strategies below can use date-first matching.

## Source search and cancellation

Pure positive Fuzzy OR alternatives share one tsquery and one match union
across body, filenames, current attachment revisions and audio filenames.
Alternatives containing AND or negative tokens retain their original grouping.
For a fully bounded period of at most seven days, Fuzzy OR searches with
excluded quoted phrases materialize date/access-eligible IDs first, select
positive matches, then check exclusions only on those matches. Other filters
remain in the outer query; this candidate scope never replaces authorization
or removes a facet's own-filter rules. Longer and unbounded periods retain
indexed match-set planning. Bounded complex Fuzzy searches
disable JIT locally inside a read-only transaction; the setting cannot leak
to a pooled connection.

Date-bounded interception-time inbox candidates and maps start from the inbox
date range before looking up messages. Map peleng and source access predicates
remain correlated to each candidate. The network facet uses inbox IDs for
literal attachment membership when its inbox join is obligatory, enabling the
existing body/index bitmap OR. Six-month common-word Exact searches can still
be slow; index selection alone does not establish their latency.

Wrapped analysis/inbox/frequency and network-activity source reads share eight
SQL slots per API process. Ordinary reads retain two slots per authenticated
login and a ten-second admission/pool wait. Text-search counts additionally
share four count slots, with two per login in a separate class; this leaves
capacity for pages, including pages from the same login. At most four source
search-count operations, two per login, execute concurrently; additional
facets queue within their request budget. This lets admitted counts finish rather
than interleaving every facet until all expire. SQL permits are released after each
query; count-operation admission is separate from ordinary reads. Their admission and identical-count queue
waits can use the remaining whole-request budget; acquiring a pooled connection
still has a ten-second bound.

The existing eight fallback-operation slots, limited to two per login, cover
ordinary fallbacks and query-policy source routes. Search counts use the SQL
count limits instead of holding an operation slot for their entire request.
Windowed network fallbacks likewise rely on statement admission and release
capacity between days. Count coordination is keyed by operation, pool, login and filters: identical
requests queue while unrelated facets can progress. Limits are process-local.
Ordinary fallbacks caused by configured analytics failures,
freshness/coverage/revalidation failures, open circuits and query-policy source
routes use operation admission. An unconfigured
analytics stack relies on SQL admission. Capacity/fairness regressions live in
`wdintel-rs/src/read_query/tests.rs` and
`wdintel-rs/src/rer_importer/analysis/tests.rs`.

Each wrapped source query pins its connection and backend PID/start time.
Dropping a read sends a cancellation through an independent connection with
a three-second budget, retaining the query slot and checked-out connection
until cleanup. That connection is discarded rather than reused. Paged source
reads retain their single repeatable-read, read-only snapshot. Analytics,
workers and writes keep their existing drivers. Cancellation failure is logged
as `cancel_sent=false`; it is not proof that SQL stopped.

The activity recorder surrounds the read deadline and records the actual error
status once. Request IDs link count waits, source admission/pool/SQL spans,
fallback outcomes and deadline errors. Use successful completions and queue
latency together when assessing the limits; faster 503s alone are not recovery.

Unbounded, limited `load_latest` analytics pages first probe the last two days
by message creation time, rounding the lower boundary down to a minute so
requests can share the existing short-lived ID-bounds cache. This preserves
the existing effective ordering of these requests. A full 20-ID page is
sufficient because every excluded message is older than the probe's
creation-time boundary. Sparse or empty probes repeat
the existing complete-history selection so older matches are retained.
Explicit time/cursor scopes and unlimited reads keep their existing behavior.
Source freshness, authorization, revalidation and fresh-tail merging still
apply; the probe does not assume message IDs follow interception time.

## Historical text-search counts and pages

Historical source searches and counters execute over the complete requested
period. They do not probe and then split into calendar months or days after a
timeout. Expensive requests fail within their SQL/HTTP budgets instead of
launching more scans. Existing message-ID batches for native memory bounds and
network-activity aggregation remain separate from this policy.

Paged source searches select at most 20 IDs in the requested order, then hydrate
those IDs in the same repeatable-read snapshot. Interception, timestamp and
creation ordering, timestamp/ID cursors, inclusive inbox bounds and exclusive
analysis bounds are retained. Count failures return errors, never partial totals.
Groups retain missing-secret-group behavior; facets retain their own filter
removal, authorization, attachment revision and freshness checks.

### Execution budgets

Nonblank text searches default to the smaller of the ordinary source statement
timeout and 30 seconds, with a 60-second total HTTP deadline, including
admission and count queues. Local SQL settings are restored before pooled reuse.
Cancellation still pins and cleans up the active source connection. React's
605-second search allowance supports explicitly extended backend settings; the
backend's shorter default determines when a request fails. Filter reloads, feed
removal and unmounting abort pending Duty page/count requests.

Optional overrides in `config.toml` remain supported:

```toml
[postgres_runtime]
search_statement_timeout_ms = 30000
search_http_timeout_ms = 60000
```

The HTTP budget must exceed the search statement budget and cannot exceed
600,000 ms. Existing SQL overrides of 60 seconds or more retain the previous
600-second HTTP default when no HTTP override is supplied. An explicit HTTP
override must exceed the SQL budget. Existing lock, idle-transaction and worker
settings keep their separate meanings. The default policy also applies when `[postgres_runtime]`
is absent. Longer budgets require an intentional operator override; proxy
read deadlines must exceed the selected backend HTTP deadline. Any change to a
real environment requires separate approval under `AGENTS.md`.

### Analytical literal search

Exact and Substring retain source routing. The gateway plans reviewed in
[iteration 12](../../archive/2026-10-12-perf/iteration12/findings.md) still evaluated
literal body predicates locally; removing the routing guard would transfer
large inputs rather than enable useful native filtering. Windowing does not
change this support boundary. Native literal search requires separate gateway
predicate-pushdown work and actual prepared-plan/result verification.

## Network activity fallback

The final native network-group aggregation runs sequential disjoint ranges of
at most one million message IDs, with explicit bounds on the link, inbox and
message inputs. It sums matching day/group/network buckets and keeps the latest
activity timestamp. This is separate from the existing period-bounds query.
A failed range discards the entire analytical result before source fallback.

The source fallback visits daily time ranges. Indexed interception-time
candidates and separate timestamp/creation branches preserve the original
`COALESCE` behavior for null interception times. Matching network links are
resolved before message/access/frequency joins. Buckets spanning window
boundaries add rather than overwrite. The three network-activity routes now
share ordinary read admission, cancellation and the 60-second HTTP deadline.

These bounds reduce individual query memory; they do not establish a safe
installation-wide native concurrency limit. Pivnich permitted 32 queries with
an 8.80-GiB shared cap and a 2.20-GiB per-query cap. Those operational limits
were assessed and left unchanged. Compare aggregate-memory exceptions and
useful completions under concurrent traffic before proposing a limits change.
See [iteration 14](../../archive/2026-10-12-perf/iteration14/implementation.md)
for diagnostic evidence and rollout limits.

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
worker removes at most 500 entries older than 24 hours plus the maximum ten-minute
search request deadline every minute; pending changes are never pruned. The extra interval
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

Use the [production verification checklist](3780-verification.md) for repeatable
post-deployment windows, representative workloads and ingestion checks.

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

For an analytics inbox request using direct unit IDs without the ordinary
header/network unit branch, apply the same bounded unit membership predicate
once, using `sigint_inbox_item.id`. Keep the message-ID range constraints on
both `sigint_inbox_item.id` and `signal_message.id`. Their join equates these
IDs; repeating the membership predicate for each side causes the gateway to
scan the unit-link history twice. The combined header-unit OR direct-ID branch
retains its original matching semantics.
Nonempty, empty, denied and combined-unit cases are covered by the existing
unit-ID regression. Gateway resource limits and resource-specific fallback are
described in the [analytics operations guide](../../deploy/clickhouse/README.md#gateway-resource-limits).

Frequency and unit inbox filters, including selected and denied unit IDs, read
analytics candidates in disjoint message-ID ranges, capped at four million IDs
for closed ranges. Tag, network, metadata and daily activity statistics cap
closed ranges at one million IDs. Recent scopes resolve a high-water mark using
PostgreSQL's indexed maximum message ID and retain a lower-bound-only final range,
so messages arriving during
planning remain eligible. Closed scopes retain their upper bounds; empty scopes
issue no range queries. Unit-name, network-association and AOR lookups are shared
across inbox ranges within each operation. At most two range queries
run concurrently per operation; existing query deadlines, memory limits and
fallback admission limits remain in effect. Every range uses the original
authorization and filter predicates, including bounds on related tables.
Inbox candidates are merged using the requested timestamp and ID ordering before
applying the page limit. Statistics sum distinct-message counts across disjoint
ID ranges, retaining per-message deduplication and metadata normalization.
A failed range fails the complete analytics attempt and uses the existing
PostgreSQL fallback; partial totals are never returned. No migration, resnapshot
or gateway configuration change is required.

Local range-planning checks on 2026-10-25 used PostgreSQL 14.24 and ClickHouse
26.3.12.3 with 38.8 million synthetic, sequential message IDs. PostgreSQL's
`SELECT MAX(id)` on a bigint primary key produced `Result -> Limit -> Index Only
Scan Backward`, returning one index row with four shared-buffer hits, one heap
fetch, no temporary I/O and 0.037 ms execution time. The read had an eight-second
statement timeout. This isolates the range-planning access path; it does not
measure the complete inbox or facet query.

The equivalent ClickHouse current-state fixture used
`ReplacingMergeTree(_peerdb_version) ORDER BY id`, `FINAL` and
`_peerdb_is_deleted = 0`, matching the reconciled current-view semantics. After
one million newer row versions, `EXPLAIN indexes=1 SELECT MAX(id)` selected all
4,865 granules with an unrestricted primary-key condition. A one-million-ID
bounded distinct count selected 123 of 4,863 granules from one part; a separate
range containing 100,000 newer tombstones correctly counted 900,000 live IDs.
The local queries used two threads, a 2-GiB memory cap and an eight-second
execution limit. These synthetic checks establish indexed range selection and
current-version deletion handling. Production gateway plans, replication
freshness, concurrent memory use and end-to-end latency still require the
ordinary approved canary before rollout; no environment repair is implied.

The PostgreSQL unit-match breakdown reads only the requested filtered counts,
without discarded overall totals. Requests without a unit-name filter reuse one
count; aggregate-cache reads and recovery-conflict retries remain available.

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
shape. These modes remain on PostgreSQL and do not attempt that gateway path.
Full-period source searches collect distinct matching filename, current
attachment-chunk and audio-filename IDs separately. The body predicate remains
on the inbox relation, combined with `id = ANY(ARRAY(...))` attachment membership.
With an obligatory inbox row, PostgreSQL can combine the body GIN trigram index
and inbox primary key in a bitmap OR, or choose a scoped scan for common terms.
Optional inbox rows use message IDs for membership so attachment-only messages
remain searchable. Hydration and fresh-tail reads retain candidate-ID checks.
Body and wildcard-only filename predicates preserve empty/null behavior;
other filename predicates use the existing trigram index directly.

Source queries with one selected nonempty frequency also correlate search terms
to candidate IDs. The frequency facet keeps its existing strategy because it
deliberately ignores its own selected-frequency filter. Broad source queries
retain indexed match-set planning. These choices preserve authorization, dates,
negation, attachment revision checks and analytics eligibility. The concurrent
source-index migration refreshes expression statistics with `ANALYZE` and
requires no analytics resnapshot; see the
[Pivnich measurements and rollout checks](../../archive/2026-10-12-perf/iteration9/findings.md).

Web source and replica pools force custom prepared-statement plans so a common
literal term can use its own selectivity rather than a cached rare-term plan.
Runtime statement/lock/idle-transaction deadlines remain applied in the same
connection-options mapper. Analytics retains its existing custom-plan setting;
worker, file-registry and operator pools retain their existing plan-cache policy.
Monitor planning CPU alongside execution cost when accepting this change.

Read-only unit-count diagnostics with the incident's group scope and
`нора` took 66 ms for one day and 3.68 s for 30 days on 15 October 2026; the
30-day plan still scanned large joined relations and spilled temporary data.
These isolated timings do not establish a latency guarantee under concurrency
or resolve the separate PostgreSQL count-query performance issue.
