# #3780 historical search and network activity implementation

27 October 2026. Branch `3780-skhid-503s`, based on local commit `36579ca83`.
These changes are local. No application deployment, remote repair, configuration
change, statistics refresh or database write was performed on either server.

## Historical counts

The [iteration 13 decision](../iteration13/decision.md) accepts independent
historical snapshots. Add message counts over disjoint intervals; union distinct
entity identities before counting. Failed windows fail the complete request.

For source text searches exceeding three calendar months:

1. Probe the complete indexed query for eight seconds. Fast/empty searches finish
   without splitting or repeating index work.
2. On timeout, traverse windows capped at three calendar months. Each indexed
   window has an eight-second probe. This cap follows the measured repetition
   cost; it is not a universal latency guarantee or a return to the arbitrary
   two-month proposal.
3. When a window exceeds its probe budget, finish it and the remaining period
   through daily date-first queries, each capped at eight seconds. A smaller
   operator search SQL limit takes precedence.

Daily Exact/Substring predicates materialize date IDs before literal matching,
use inbox primary-key lookups for body text, and bound filename/current-document
attachment membership to those candidates. Access and other filters remain in
the original outer query. This avoids access lookups on every date candidate and
repeated global body GIN scans. Fuzzy predicate semantics remain unchanged.

Message totals, sender/post/frequency/unit/location identities, normalized
callsigns, tags, AORs, networks and groups use the shared traversal. Undefined
units retain their existence bucket, null/empty values retain existing facet
semantics, missing secret groups are included once, and facets retain their
own-filter removal. Inbox digests sum counts and take the earliest timestamp.
Inbox's inclusive upper bound is converted to an exclusive microsecond bound;
candidate millisecond bounds round outwards and retain the exact SQL constraint.

Each successful count window commits separately and releases SQL admission.
Cancelled/failed windows cannot publish partial totals. Historical imports or
edits between windows can change the result slightly, as explicitly accepted.
Shorter and unbounded requests retain their existing query strategy.

## Pages

Long bounded source text pages first probe the indexed query for 250 ms. If it
expires, visit three-month windows in requested order. Each tries a one-second
ordered date-index scan, then the indexed window query if the probe expires.
Stop at 20 IDs; do not traverse the rest of the period after filling the page.
The indexed alternative is essential for sparse/no-match searches.

All three time bases, both directions and timestamp/ID cursors remain intact.
Selection and hydration share one repeatable-read, read-only transaction.
Probe timeouts roll back to a savepoint, restoring SQL settings and preserving
that snapshot before the next strategy. Unlimited reads retain their path.

## Deadlines, capacity and cancellation

A validated nonblank search selects a 90-second SQL budget and a 600-second
whole-request HTTP budget by default. Ordinary reads retain the 60-second HTTP
budget and existing pool SQL settings. Optional `[postgres_runtime]` settings
`search_statement_timeout_ms` and `search_http_timeout_ms` override the search
policy; HTTP must exceed SQL and cannot exceed 600,000 ms. The search defaults
also apply when the optional section is absent. SQL settings are transaction
local and do not leak to ordinary reads.

React Analysis counts and Duty search reads allow 605 seconds. Ordinary
35-/65-second frontend deadlines and cancellation on filter changes remain.
Elm reads already have no independent request timeout; no binding change was
needed. Read-only proxy inspection found a 3,600-second API read timeout on
Skhid and a 1,200-second configured timeout on Pivnich, both above the search
HTTP budget. Skhid's 75-second override belongs to event-stream long polling.
No proxy configuration was changed.

All wrapped source SQL still shares eight slots per process. Search counts
additionally share four slots and two per login in a separate class from the
two ordinary per-login slots. This leaves source capacity for pages, including
the same user's pages. A separate whole-count admission limit allows four
source count operations, two per login, to traverse windows concurrently.
Additional facets queue rather than interleaving every expensive window until
all requests expire. This admission does not occupy ordinary operation slots.
Count admission/identical-request queues may wait within the search HTTP budget;
pool acquisition remains bounded at ten seconds.

Long search counts do not hold whole-operation fallback permits throughout the
traversal: their actual SQL holds the stricter count/source permits. Windowed network fallbacks also use statement admission during HTTP requests,
so their gaps between daily queries do not hold whole-operation slots. Ordinary
fallback-operation limits remain eight globally and two per login. Identical
count operation/filter/login requests queue; different facets can progress.
Pinned cancellation retains permits until backend cleanup, as in iteration 12.
Limits remain per process, not installation-wide.

## Pivnich network activity

The [incident findings](findings.md) identified the final joined aggregation as
a different stage from the already-chunked period-bounds query. The final native
query now uses disjoint one-million-ID ranges with explicit bounds on the link,
inbox and message inputs. It adds day/group/network buckets and takes the latest
activity timestamp. Any failed range discards the entire native attempt.

Source fallback uses sequential daily candidates. Interception dates use their
index; separate timestamp and creation branches cover null interception times
with the original `COALESCE` semantics. Network-link primary-key lookups narrow
these IDs before message/access/frequency joins. A materialized candidate set
prevents the planner from returning to full-history matching. The original
network/frequency validity, access, archive/deletion and Kyiv grouping rules
remain. Counts add across UTC windows even when a Kyiv day spans two windows.

The three network-activity routes now share ordinary source admission,
cancellation and the 60-second HTTP deadline. Their SQL remains subject to the
ordinary source timeout rather than receiving the text-search budget.

The shared native admission issue was assessed: 32 allowed queries can exceed
an 8.80-GiB user cap despite separate 2.20-GiB query caps. Limits were left
unchanged. Bounding the largest observed query reduces individual demand;
installation-wide admission tuning still requires concurrent-traffic evidence.

## Production-scale read-only evidence

Sanitized data: [implementation measurements](implementation_measurements.json).
Terms, IDs, group keys, full SQL/plans and credentials remain outside the repo.
These are SQL diagnostics, not application HTTP benchmarks.

Additional Skhid count prototypes confirmed that smaller calendar windows alone
are insufficient. Fully correlated and access-first alternatives reached their
eight-second limits. Moving date filtering before access produced a one-day
common Exact count in 1,417.703 ms, with 177 eligible matches and no global body
GIN access. Seven-day variants still exceeded eight seconds. A selective
three-month indexed control completed in 6,857.316 ms; a no-match control
supports retaining the indexed first attempt. Cold-cache and concurrent costs
remain variable.

On Pivnich, plain EXPLAIN of the new bounded native SQL showed a single remote
aggregation and explicit ID bounds on both large joined inputs. Two disjoint
one-million-ID probes completed in 375/386 ms and tracked 36,381,218/46,590,493
bytes of native memory; one returned 1,104 groups, one was empty. The retained
unbounded-input failure had hit the 2.20-GiB query cap. This is a bounded-range
comparison, not an equal-work whole-request speedup claim.

Source network prototypes showed why merely driving all historical network
links or splitting dates while hashing all links was insufficient: several
variants reached eight seconds, and two full-period variants reached 20 seconds.
An indexed daily candidate/link prototype completed a nonempty day in 1,650.602
ms with no reads or temporary writes in that warm run. A complete incident
period (about ten days) then traversed all 11 daily windows in 40,099.160 ms
of summed SQL execution, maximum 8,063.637 ms per window, with no temporary
writes. An earlier eight-second attempt stopped on its first window. Daily
bounds make progress measurable; they do not establish a comfortable latency
margin under peak traffic.

## Validation and release limits

Validation results are recorded in [progress](progress.md). Production-scale
source evidence uses reconstructed filters/prototype SQL; functional tests
exercise the actual query builders. Native gateway evidence uses the new SQL
constant with captured representative parameters.

Exact/Substring source routing remains intentional: reviewed gateway plans
still applied literal predicates locally. Removing the guard is not an
analytical search implementation. Native literal support needs separate
predicate-pushdown work and prepared-plan/result verification.

No new schema migration, statistics refresh, resnapshot or operational limit
change is required for this application change. A separately approved deployment
must compare complete HTTP requests and useful completions under normal/peak
traffic, cancellation, count queues, source load, aggregate native memory and
ingestion/replication. A six-month daily count may still reach its overall
budget; no complete six-month HTTP canary or multi-user replay has been claimed.
