# Historical source-query windows: decision and measurement plan (#3780)

27 October 2026. This follows the [Exact-search and 503 investigation](../iteration12/findings.md)
and its [locally prepared fixes](../iteration12/implementation.md).

The user authorized sequential time-window execution for counts and inbox pages,
then asked to document the decision and measure window sizes before implementing.
No windowing implementation or deployment is part of this measurement round.

## Accepted semantics

- Independent read transactions per historical count window are sufficient.
  The user considers historical data barely mutable and accepts the small
  inconsistency from imports/edits while several windows execute. No shared
  repeatable-read snapshot is required across the complete count.
- Message totals add across non-overlapping windows. Distinct facet totals
  require union/deduplication of entity identities. Failed windows cannot be
  silently omitted from a final total.
- Inbox pages walk windows in the requested sort-time order, retaining stable
  timestamp/ID cursors and stopping once the requested page is full. Cursor
  bounds, outer period inclusivity and optional inbox rows must be preserved.
- Existing authorization, revision, freshness, admission and cancellation
  protections remain applicable. Accepting historical changes does not waive
  these protections.
- Two-month windows and a three-month activation threshold were examples,
  chosen without evidence. Both remain undecided; measurements may support
  smaller or larger windows, or show that a different query plan is required.

## Measurement design

Reuse the session's unlocked SSH access to `echo-skhid`. Inspect the installed
package, source load and schema before testing. Run one read-only SQL diagnostic
at a time, inspect plain plans first, and apply defensive statement/lock/idle
transaction limits. Do not install packages, change indexes/statistics, flush
caches, restart services, write application/health metadata or reset counters.

Compare weekly controls and calendar spans of one, two, three and four months,
plus the existing complete-period baseline. Use fixed captured search/filter
parameters and period endpoints. Include both captured short Exact patterns,
message counts, distinct facet keys and ordered 20-ID pages. Separate the
existing indexed match-set shape from any diagnostic candidate-first prototype;
do not attribute a plan change's benefit solely to the window width.

First compare suffix windows with the same upper bound. Then compare complete
partitions of the same historical parent range for viable window sizes, summing
execution/buffer cost and merging keys/IDs as appropriate. Pages should stop
once full and exercise sparse/no-match windows as well as dense recent data.
Report cancelled probes as censored lower bounds, never as completed timings.

Capture actual execution/planning time, rows, candidate cardinality, shared
reads/hits, temporary writes, plan shape and result fingerprints. Repeat useful
comparisons in a different order without forcing cache state. Read production
load between batches and stop diagnostics if they would contend materially
with application traffic. Isolated SQL timings do not establish concurrent HTTP
latency or prove that the complete count fits its overall deadline.

Raw search strings, access keys, identifiers and plans stay in private local
artifacts. Commit only sanitized summaries, reproduction methodology and
limitations. The deployed schema may lack the current checkout's audio-search
relation; inspect it, and keep old/new query arms consistent if needed.

## Outcome

The [read-only measurements](findings.md) are complete for two captured Exact
terms and a synthetic no-match control; sanitized per-probe data is in
[measurements.json](measurements.json). No default span, activation threshold
or timeout change has been selected. A blanket calendar split is not supported
by these results: smaller windows repeat global text work, and ordered page
scans have very different behavior for dense matches and no matches.
