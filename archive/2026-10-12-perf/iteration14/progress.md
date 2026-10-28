# #3780 progress and remaining operational work

27 October 2026. Branch `3780-skhid-503s`. Local implementation and validation are complete;
the root `wip.md` has been removed. No remote deployment or repair was performed.

## Investigation completed

- [Iteration 12](../iteration12/findings.md) classified the October 26 Skhid
  failures: 143 confirmed 503s, including SQL timeouts, HTTP deadlines omitted
  from response-only telemetry, and fallback-capacity rejections. Its source
  search, cancellation, admission and telemetry fixes were committed locally in
  `36579ca83` before this implementation round.
- [Iteration 13](../iteration13/findings.md) measured 83 SQL probes: 61 completed,
  22 reached eight seconds. Smaller calendar windows repeated global index work;
  ordered pages helped dense matches and hurt a no-match control. Distinct-key
  unions matched the parent count; summing distinct counts did not.
- [Pivnich findings](findings.md) document the initial burst, the user's deployment
  and recurrence. The upgrade did not eliminate fallback saturation, native
  aggregate-memory failures or the final network aggregation's query-memory
  failures. Healthy later snapshots did not invalidate request-scoped attachment
  guards. No resnapshot was justified.

## Accepted and implemented decisions

The user accepted independent historical snapshots because old data is barely
mutable. Counts use disjoint intervals, message totals add, distinct identities
union, failed windows fail the whole request, and pages stop once filled.
Authorization, current attachment revision/freshness rules and cursors remain.

The requested implementation is described in [implementation.md](implementation.md):

- Adaptive indexed-parent, three-month and daily count strategies; daily
  date-first body/attachment matching for expensive Exact/Substring counts.
- Sequential count/digest traversal and exact facet identity merging.
- Indexed/ordered page probes with selective-index fallback, all time bases and
  timestamp/ID cursors, retaining one selection/hydration snapshot.
- Separate configurable search SQL/HTTP budgets and coordinated frontend limits.
- Separate count-operation admission so admitted counts can finish, reserved
  source capacity for pages, and cancellation/deadline handling across windows.
- Evaluation of analytical Exact/Substring routing: retain PostgreSQL because
  the reviewed gateway plans still evaluate literal predicates locally.
- Bounded final native network aggregation, daily source candidates, and
  network-route source admission/cancellation/deadlines. Shared native limits
  were assessed without changing the real environment.

The three-month cap is an initial strategy ceiling supported by relative
partition costs, not a guarantee that a calendar width is fast. A probe changes
strategy according to actual work. Additional [sanitized measurements](implementation_measurements.json)
include a 1.418-second daily Exact count, 375/386-ms native network ranges and a
complete 11-window source network traversal totaling 40.099 seconds of SQL time.

## Validation

Final validation passed on the complete implementation:

- 58 active #3780 regressions; the existing scale benchmark remains ignored.
- 147 analysis tests (one existing ignored case), 153 inbox tests, ten native
  network tests, three source-network tests and three deadline tests.
- 22 related attachment tests passed; one existing benchmark stayed ignored.
- `cargo check`, strict all-target/all-feature Clippy, `cargo fmt --all --check`,
  full frontend build and `git diff --check` passed.
- Updated older count regressions to retain identical-request serialization,
  allow independent facets, and verify query-policy capacity is released.
  New database tests cover daily boundaries, permissions, current attachment
  semantics, exact identity unions, failed-window propagation, stable pages,
  pooled timeout/snapshot restoration and count/network admission fairness.
- Used dedicated local source/file databases. A temporary local tokenizer
  dependency supported the inbox submission test and was stopped afterward.
  Shared build-directory contention was avoided with an isolated target;
  other checkout jobs were not interrupted.

Frontend validation:

- 132 related Vitest cases and both #3546 creation-time regressions passed.
- All 43 affected Playwright cases passed across the suite and targeted reruns:
  Analysis search modes/device counts, Duty polling and scroll stability.
  Initial failures exposed stale help-text/drawer expectations and programmatic
  scrolling that did not simulate user input. Only those tests were corrected;
  the failing cases then passed with real wheel input.
- Full `just build-front` passed; changed frontend files were formatted and
  `npm run format:staged` completed.

## Remaining operational verification

Local implementation is separate from production acceptance. Deployment still
requires explicit approval naming the target and operation under `AGENTS.md`.
No approval to deploy or repair either host has been inferred from SSH access.

After an approved rollout:

1. Compare complete six-month HTTP searches, including dense/short, selective
   and no-match terms, first/later pages, every facet and attachment freshness.
   Measure useful completions and total cost, not only individual windows.
2. Exercise simultaneous users and same-user counts/pages. Record queue latency,
   cancellation cleanup, source load, native aggregate-memory exceptions,
   ingestion and replication. Counts still have finite total/per-window budgets.
3. Compare complete native/source network activity, full traversal time and
   memory. The measured 40-second source prototype has limited peak-load margin.
   Source prototype plans and native range plans do not replace HTTP canaries.
4. Use evidence from concurrent traffic to decide whether native shared admission
   needs a separate change. Per-query bounds alone do not eliminate shared-user
   memory failures. Keep the 32-query/8.80-GiB operational limits unchanged until
   a concrete change is reviewed and approved.
5. Treat native Exact/Substring predicate pushdown as separate gateway work.
   Do not remove source routing while literal predicates are evaluated locally.

These are deployment acceptance and separate analytical/operational follow-ups,
not an assertion that every six-month query now fits its budget. Durable
behavior and verification procedures are in
[search routing](../../../docs/performance/3780-search.md) and
[verification](../../../docs/performance/3780-verification.md).
