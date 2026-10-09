# Callsign page API

`POST /api/rer/analysis/callsigns-page` is the bounded alternative to the
legacy callsign statistics endpoint. Its `AnalysisCallsignPageReq` wraps an
`AnalysisStatsReq` in `req`, plus `query`, `order`, optional `page_size`, and
optional `cursor`. It removes the callsign filter before calculating available
values. The default page size is 50; explicit sizes are clamped to 1–100.

Each entry contains a normalized `label` (`upper(trim(callsign))`), a
representative raw `value`, the complete distinct raw spellings in `values`, and
the aggregated `count`. Consumers normalize raw values before matching filter
selections. Counts preserve the existing callsign-occurrence aggregation; they
are not a new distinct-message calculation.

The opaque cursor is bound to the serialized effective request with the
callsign filter removed, the supplied search text, ordering, and clamped page
size. Equivalent searches with different casing or whitespace do not share
cursors. A cursor from another search or effective filter scope is rejected.
Authorization is applied when each page query is built. `has_more` and
`next_cursor` are the pagination contract; the endpoint does not calculate
an exact total merely to paginate.

Pages are keyset pages, not a snapshot. New messages or edits between requests
can change a callsign's count and therefore its rank. The next request resumes
after the cursor key in the then-current ordering, so callers must refresh from
the first page when they need a current complete ordering. The Neo UI resets to
the first page whenever its search or effective analysis filters change.
Changing only the callsign selection does not invalidate the available-values
page, because that facet is deliberately excluded from its scope.

The Neo callers debounce requests by 250 ms, cancel obsolete requests, and
reject late responses. They retain the current result page and may temporarily
retain the preceding page for a loading backdrop during a scope change; they
do not accumulate all visited result pages. Failed first-page and navigation
requests expose a retry action; retry uses the failed request's cursor so a failed next page can
be retried without discarding the displayed page. Cursor history retains the
first page plus the latest 19 page cursors. Previous navigation is disabled
once an earlier cursor falls outside that window; the first-page action remains
available in the right callsign pane and left callsign filter. Initial loading
uses a skeleton in the right pane; subsequent loading uses a spinner with a
backdrop. Load failures are reported through the existing toast notifier as
well as contextual retry UI.

`count_desc` orders by aggregated count descending, then normalized label. Search
uses `match_then_name`: an exact normalized-label match first, then normalized
label. Search is a case-insensitive, trimmed literal substring search: `%`,
`_`, and `\` are escaped rather than interpreted as wildcard syntax. The cursor
stores the full order key, including exact-match priority, so
an exact match cannot cause later label-ordered results to be skipped.

## Exact-order work per page

The server prepares the effective analysis scope with the callsign facet
removed, then expands raw callsign variants, filters a nonempty search before
grouping, and calculates each normalized label's exact count. For
`count_desc`, it first aggregates exact `(normalized label, raw spelling)`
pairs, then sums those pair counts and constructs the raw-variant array for
each label. This shares the occurrence stream between counts and variants and
avoids the former second full candidate scan. The cursor seek is applied to
those grouped count/order keys. It keeps every returned label's count and raw
variants complete, but `count_desc` necessarily aggregates the whole effective
scope before it can rank a page. For later
`match_then_name` pages, the builder can exclude whole normalized labels that
sort before the cursor before grouping. That is safe because no excluded label
can occur on a later page. It must not exclude individual raw callsign rows for
a retained label: doing so would corrupt that label's count or raw variants.

There is no cross-request callsign-result cache. Pages remain exact live
keyset pages with bounded responses, rather than bounded database work.
Introducing cached rankings or precomputed results would be a separate design
change requiring filter and authorization isolation, data/permission
invalidation, bounded storage, and an explicit freshness contract.

## Verified optimization and production confirmation

The bounded UI/API and two-stage backend aggregation are implemented. The
measurements below establish an improvement on the synthetic fixture;
production-scale confirmation is a separate remaining validation step, not an
unimplemented part of this optimization.

Measurements using the actual production statement builder on an isolated
synthetic fixture with 1.2 million messages and 100,000 normalized labels used alternating
baseline/candidate runs with three observations per query and page. Broad
first pages took 3.70–3.88 seconds before and 2.96–3.12 seconds after the
two-stage aggregation; broad later pages took 3.50–3.65 and 3.12–3.20 seconds.
Median execution time improved by 20% and 14%, respectively. These are
synthetic measurements without resetting PostgreSQL buffers. The new broad
plan still processes 2.28 million candidate occurrences, but reduces temporary
I/O from 10,825 read / 10,836 written blocks to 2,025 / 3,140 by collapsing them to 120,570
label/spelling pairs before array construction. `match_then_name` retains its
previous shape: the label boundary excludes only labels that cannot occur on a
later page, while complete counts and variants remain calculated for retained
labels. It has not established a selective, bounded access path across the
large message and callsign relations; current plans still scan the complete
filtered message scope. The paired comparison used alternating
baseline/candidate order and identical parameters. An earlier capture had an unexplained timing shift and was excluded
from these latency comparisons. These figures measure PostgreSQL execution,
not end-to-end browser latency or performance under concurrent production load.

The ignored `capture_callsign_page_production_builder_plans` test in
`wdintel-rs/src/rer_importer/analysis/tests.rs` captures current statements
through the production builder with
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)`. It requires the dedicated
benchmark fixture, including its `callsign_benchmark_state` table; selecting an
arbitrary restored database is insufficient. Select that database through
`TEST_DB_NAME` and set `CALLSIGN_PLAN_OUTPUT` to an output directory outside the
checkout. Its cases cover broad first/later pages, partial first/later/deep
search pages, exact and case-variant searches, no matches, and a narrow
frequency/network scope. It captures the current page query, not a legacy or
pre-change baseline.

Before claiming that the reported production timeouts are resolved, compare
the pre-change and current implementations on a representative 30–60-day
production dataset or isolated restored copy. Match the active-message
fraction, callsign-cardinality distribution, authorization/filter scope,
parameters, cache conditions, and concurrent load. Capture broad, selective
search, and subsequent-page plans using the same `EXPLAIN` options, recording
scanned rows, buffers, aggregation/sort work, spills, and execution time.
Measure response size and browser responsiveness separately. A date range or
large total message count alone does not establish a representative workload: an
earlier restored 60-day sample left only 61 items and 24 labels after the
active-message predicate and could not validate high-cardinality performance.

The remaining limitation is explicit: broad count-ranked pages still aggregate
the complete effective scope. The implemented optimization reduces that work
and bounds frontend data volume; it does not guarantee that every production
scope will complete within its query timeout.
