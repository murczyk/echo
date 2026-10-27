# #3780 search performance: work in progress

Updated 27 October 2026. Branch: `3780-skhid-503s`.
Changes are local and uncommitted. No deployment or remote repair was performed.
Real-environment changes require separate approval naming the operation and target.

## Completed investigation

- Read the earlier #3780 performance rounds and investigated the October 26
  Skhid deployment. The 12:50–15:00 UTC window had 143 confirmed 503s: 76 source
  SQL timeouts, 41 HTTP deadlines and 26 fallback-capacity rejections. Response
  telemetry omitted deadline completions; the initial response-only count was
  incomplete. See [iteration 12 findings](archive/2026-10-12-perf/iteration12/findings.md).
- Identified repeated global Fuzzy OR/negative match work, cross-facet count
  queueing, source work outliving cancelled callers, a missed Exact network
  index path and a separate map candidate-plan problem. Recent attachment
  changes correctly triggered source fallback; history resnapshotting or
  removing freshness guards was not justified.
- Exact/Substring searches currently use source PostgreSQL. Earlier gateway
  plans evaluated literal body predicates locally instead of pushing them into
  ClickHouse. Native Exact support remains a separate query/gateway task.

## Implemented locally

- Combined pure positive Fuzzy OR terms and added the measured, bounded
  date/access-first strategy for short Fuzzy OR searches with excluded phrases.
- Scoped date-bounded inbox/map candidates; corrected the Exact network facet's
  obligatory-inbox membership key so the existing body trigram index can be used.
- Added process-wide and per-login source admission, operation-specific count
  queues and bounded waits, including query-policy routes.
- Added pinned source-query cancellation and connection cleanup while preserving
  the existing page selection/hydration snapshot.
- Recorded actual HTTP deadline statuses once and linked source stages to the
  activity request ID.

Details, limitations and rollout notes:
[iteration 12 implementation](archive/2026-10-12-perf/iteration12/implementation.md).
Read-only probes improved the complex Fuzzy diagnostic to 1.783 s and the map
diagnostic to 2.054 s. Six-month Exact cost was not resolved by index selection
alone: one corrected network probe took 8.537 s and another reached a 20-s limit.

Validation passed for that local implementation:

- 49 active #3780 regressions; the existing 250k-row claim benchmark stayed ignored.
- 51 related analysis, 20 attachment and 66 inbox tests.
- Strict all-target/all-feature Clippy, `cargo check`, formatting, front-end build
  and `git diff --check`.
- The local NLP dependency was temporarily started for an inbox submission test
  and stopped afterward. No browser regression or concurrent HTTP replay ran.

## Accepted windowing decision

The user authorized sequential historical windows for counts and inbox pages,
then requested measurements before choosing spans or implementing windowing.
Historical data is considered barely mutable: independent read transactions
per window are accepted, including the small inconsistency from concurrent
historical changes. Do not hold a snapshot across the entire historical count.

Message counts add across non-overlapping intervals. Distinct facets merge
entity identities before counting. A failed window cannot be silently omitted
from a final total. Pages visit intervals in the requested sort-time order,
retain timestamp/ID cursors and stop when the page is full. Authorization,
attachment revision/freshness checks and cancellation remain required.

The proposed two-month width and three-month activation threshold were arbitrary;
neither is a selected default. See the
[decision](archive/2026-10-12-perf/iteration13/decision.md) and
[measurements](archive/2026-10-12-perf/iteration13/findings.md).

## Window measurements completed on October 27

83 read-only timed SQL probes on Skhid: 61 completed and 22 reached the 8-s
diagnostic limit. No settings, indexes, statistics or application state changed.

- The three-character Exact count still hit the diagnostic budget for a week
  through six months. The first candidate-first count prototype also failed to
  establish a safe small-window budget.
- For the seven-character Exact case, complete six-month partitions all returned
  19,225 messages. Three-/four-month caps completed in some runs, but cache/run
  order strongly affected elapsed time. Compared with unsplit, logical buffer
  work increased about 36% for three-/four-month caps, 72% for two months and
  180% for one month.
- Distinct-key unions matched 1,960 parent frequency keys. Summing two-month
  distinct counts would incorrectly give 2,631.
- Ordered date-index page prototypes took approximately 0.16–0.30 s for these
  dense matches over ranges up to six months. First/later pages and 0+20 / 9+11
  two-window merges matched reference results with no duplicates.
- A no-match control took 20 ms using the text index over six months, while the
  ordered scan hit the 8-s limit over seven days. No universal access plan or
  calendar window is justified.

Raw terms, keys, IDs and plans remain private. Published evidence is sanitized.
These are reconstructed-filter SQL diagnostics, not complete HTTP endpoint
benchmarks. Fuzzy/Substring modes, other sort bases and full facet semantics
remain outside this measurement round.

## Remaining implementation and validation

1. Select query strategies by measured work/selectivity, not only period length.
   Validate a bounded ordered page probe with selective-index fallback for sparse
   searches; preserve interception/creation/timestamp ordering and stable cursors.
2. Resolve the expensive Exact count path. Calendar splitting alone repeats
   global text work. Establish useful per-window bounds before implementing a
   default; retain exact distinct-key merging and the accepted consistency policy.
3. Implement window traversal/merging with focused database regressions, including
   boundaries, empty/partial windows, later pages, permission/revision checks,
   failure/cancellation and each facet's own-filter removal.
4. Coordinate search versus ordinary-read execution budgets across SQL, HTTP and
   affected frontend deadlines. Current limits are pool-level SQL, a shared
   60-s API deadline and some 35-/65-s frontend limits; no search-specific policy
   has been implemented. Multiple windows still share the overall request budget.
5. Evaluate native Exact/Substring pushdown through the analytical gateway; do
   not simply remove source routing while predicates remain locally evaluated.
6. Run the relevant Rust/front-end/browser checks and representative production-
   scale diagnostics. Prepare a reviewable release, obtain explicit target/
   operation approval for deployment, then compare useful completions, errors,
   queue latency, source load and ingestion/replication under normal/peak traffic.

## Pivnich investigation completed October 27

Used the existing unlocked SSH session for read-only investigation. Full
[findings](archive/2026-10-12-perf/iteration14/findings.md) and sanitized
[evidence](archive/2026-10-12-perf/iteration14/measurements.json) cover the initial
10:17 UTC burst, the user's 10:24 deployment and a recurrence at 10:55.

- The user upgraded `0.1.1~rc.202610252223-1` to
  `0.1.1~rc.202610261229-1`; API/worker start times became 10:24:21/10:24:46 UTC.
  The new binary still predates this workspace's uncommitted local fix.
- The initial burst had 68 fallback-capacity rejections and three source SQL
  timeouts. Eight source fallbacks, all attachment-guard related, overlapped
  the first rejection. Detailed guards reported recent changes despite complete
  historical coverage. Shared-user native memory failures began 44 seconds
  later and amplified the problem; 96 distinct such failures were retained.
- Equal nine-minute response samples had 70 selected-path 503s before deployment
  versus six afterward. The broad burst ended at 10:18, before deployment, so
  the interval difference cannot establish an upgrade benefit. Three old-cohort
  requests lacked a retained completion; their causes remain unclassified.
- All six first post-deployment 503s were network group activity: its final
  native aggregation exceeded the 2.20-GiB query cap, then PostgreSQL fallback
  reached Pivnich's 30-s SQL timeout. The already-chunked period-bounds query is
  a different stage. The final joined inputs need plan/bounds investigation.
- The 10:54–10:57 recurrence on the new package had 24 shared-user native memory
  failures and 11 retained selected-path 503s. Logs show 12 rejected fallback
  attempts, including optional enrichment, so attempts are not HTTP error counts.
  Shared native pressure and attachment-guard fallbacks competed for capacity.
- Source frequency-count timeouts continued after deployment. The active
  ClickHouse user permits 32 queries with an 8.80-GiB aggregate cap; independent
  2.20-GiB per-query caps do not prevent combined-memory failures.
- Existing health rows were healthy and history complete when inspected. This
  does not invalidate request-scoped guards or justify a resnapshot. No health
  metadata was written, failing SQL replayed or remote repair performed.

New follow-up gaps: network activity is outside the local read-deadline route
list and its PostgreSQL aggregation bypasses the new source-query wrapper.
The existing local fix therefore must not be described as resolving all of this
outage. The user requested finishing the existing work before tackling this
outage case. Its implementation, measured plan changes and approved rollout
remain a separate follow-up: bound the final network activity aggregation and
source fallback, assess shared native admission, and cover network-route
cancellation/deadlines.
