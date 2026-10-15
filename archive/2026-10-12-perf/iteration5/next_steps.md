# Follow-up work after investigation (#3780)

The investigation is recorded in [investigation.md](investigation.md), with
[sanitized measurements](investigation_measurements.json) and a read-only
[last-seen prototype](last_seen_probe.sql). The approved stabilization patch is
still described in [plan.md](plan.md); these deferred changes have not been
implemented or deployed. Do not add cross-user count sharing or raise pools,
fallback slots, deadlines or memory ceilings to compensate for expensive work.

## Recommended implementation order

1. **Network last-seen query.** Port the disjoint dated/timestamp/creation-time
   branches into the existing worker transaction. Five live Pivnich SELECT
   samples changed from exceeding 8 seconds to 2–108 ms; 608 local result
   comparisons matched across deletion, reassignment, active ranges and NULLs.
   First validate sparse/absent membership, common-frequency rejection,
   100/500-target batches, generic plans and concurrent writers. Preserve
   claimed-task handling and decreasing maxima. Canary with queue age,
   completions and block work per task; keep the existing query for rollback.
   Do not start by reducing batches or changing the worker budgets.

2. **Network-ID bounds.** Compare per-network composite-index endpoint seeks
   with current global-ID min/max. An absent ID exceeded 5 seconds in both
   custom/generic plans versus under 0.3 ms for seeks; common large arrays can
   be slower with seeks. Cover real empty/new/sparse networks, mixed/large
   arrays, NULL results and authorization before choosing the final shape.
   Existing indexes suffice for the measured prototype.

3. **GOI logs and repeated tsquery parsing.** Skhid GOI messages contributed
   60.7% of sampled application message bytes. Keep sync totals/errors at INFO
   and make row details opt-in DEBUG after checking external consumers.
   Separately attribute the live text-search notice callers: a local generic
   plan reproduced 2,000 notices for 1,000 rows, versus two with a scalar
   initplan. Validate all search modes, stopwords/numeric/negative semantics,
   GIN access and FDW pushdown before changing parsing. Do not suppress all
   PostgreSQL notices.

4. **Creation-time bounds diagnostics.** Siversk spent 156.8 database execution
   seconds and 33.3 GiB shared-block reads on 789 calls in about nine minutes.
   Its `(created_at,id)` covering index already exists. A parallel aggregate
   did not consistently reduce work and is not an accepted fix. Instrument
   bounds-cache hits/misses/load time and effective-key cardinality. Cursor
   tightening changes cache keys even for the same visible date filter.
   Benchmark conservative cached outer bounds against exact cursor bounds,
   preserving final predicates, late arrivals and fresh upper coverage.
   Inspect recent-range visibility and autovacuum eligibility before tuning;
   do not extend the five-second TTL blindly.

## Operational follow-ups and decisions

- **Journal retention/delivery:** Pivnich explicitly uses volatile storage with
  a 100-MiB runtime budget. The live shipper is `echo-vector.service`, using
  `/etc/echo/vector.yaml`, with `since_now: true` and no disk buffer. The sink
  is enabled on all three hosts; central receipt freshness remains unverified
  because the available SSH identity was rejected on the configured receiver.
  Obtain telemetry read access, verify latest events per host/unit, then test
  restart/outage replay and choose bounded persistent retention from actual
  journal growth and the required incident-history window.

- **Deployment gaps:** metadata/download/install happen after API/socket
  shutdown; the existing maintenance marker expires after 120 seconds while
  package phases allow 600/1,200 seconds. Stage downloads/preflight earlier,
  reconcile maintenance lifetime and add a bounded proxy maintenance response
  if needed. Validate download/dpkg/migration/start/readiness failures and
  recovery with older clients in an isolated installation. Current cleanup
  already attempts unmask/restart; preserve it and schema compatibility.

- **Oversized response headers:** retained errors mostly identify logout,
  plus one OAuth callback. Logout log records are truncated at 2,048 bytes,
  so full Location sizes cannot be inferred. Reproduce large synthetic filter
  redirects locally through sessions and nginx; measure the complete returned
  header block, including cookies. Then choose a bounded redirect representation
  and any justified response-buffer adjustment. Preserve destinations and
  open-redirect checks; incoming-header buffers are unrelated.

- **OCR grants and queue:** grants belong to extractor jobs, issued at
  submission with a 15-minute TTL, not to long-open user tabs. Current web/worker
  keys match. Historical job durations exceed the TTL, but rejected callbacks
  lack reason/correlation data. Add safe rejection-reason and generation/age
  diagnostics, then reproduce delayed pickup, multi-page expiry, retries,
  reprocessing and rotation before choosing refresh/TTL changes. Separately
  benchmark returning requested queue positions without changing global ranks;
  the existing helper ranks/returns the entire active queue.

- **Settlement/battle-line locks:** historical timeouts are real, but current
  snapshots did not capture their blockers. Collect a bounded blocked/blocker
  chain with transaction age and lock namespace during recurrence. Check current
  catalog refresh, uploads/reconciliation and location/AOR writers. The worker
  already commits resolution before enqueueing stats; do not reapply the old
  stats-lock explanation without new evidence. Mapping-data warnings need
  separate attribution. No timeout increase or warning suppression yet.

## Cancellation, analytics profile and broad source search

The HTTP deadline removes queued waiters, but local SQLx 0.9.0 diagnostics show
submitted SQL continues after the caller future is dropped and occupies its
pool connection until completion/server timeout. Validate explicit cancellation,
connection ownership and timeout reset locally, then gateway-to-ClickHouse
cancellation in staging. Prevent late cancellation of a reused connection.

No concurrent production replay was performed. Successful supported queries
previously reached 6.89 GiB under a 17.60-GiB analytics ceiling, despite the fixed
AOR/sender probes fitting under a 2-GiB diagnostic cap. Choose persistent gateway
thread/memory/concurrency/deadline limits only after representative restored-data
replays with ordinary and heavy reads plus CDC/merges, recording useful
throughput, p95/p99, RSS/tracked memory, cancellation and maintenance headroom.
Include reconciliation and rollback; do not apply a universal 2-GiB cap.

Wide quoted source searches remain unresolved beyond the short measured window.
The direct-body fix and constant tag-access pushdown are retained; the global
AllTags aggregate was slower and blocked pushdown. Benchmark candidate/time/group
scoping and GIN intersections, including later pages, OR alternatives and
association-row multiplicity. Preserve each user's distinct count scope.

## Recurring Duty requests

The nine-minute activity sample contained 13,170/11,428/2,680 count requests
on Pivnich/Skhid/Siversk, primarily from identifiable Duty views.
Retain the existing work to attribute count requests by frontend release, tab,
visibility and trigger before changing polling. Current server activity context
records referer and basic HTTP headers, but no dedicated release/tab/visibility
fields, so page-view aggregates alone cannot separate those causes. Preserve
unread discovery, notifications, creation-time ordering and users' distinct
filters. The earlier Analysis polling fix is already deployed; verify its
remaining traffic separately from Duty. Do not infer a per-tab polling defect
or introduce shared counts from host-wide request totals.
