# Callsign page API

`POST /api/rer/analysis/callsigns-page` is the bounded alternative to the
legacy callsign statistics endpoint. It accepts an `AnalysisStatsReq`, removes
that request's callsign filter before calculating available values, and returns
at most 50 entries by default (100 at most).

The cursor is bound to the normalized request scope, search text, ordering, and
page size. A cursor from another search or filter scope is rejected. `has_more`
and `next_cursor` are the pagination contract; the endpoint does not calculate
an exact total merely to paginate.

Pages are keyset pages, not a snapshot. New messages or edits between requests
can change a callsign's count and therefore its rank. The next request resumes
after the cursor key in the then-current ordering, so callers must refresh from
the first page when they need a current complete ordering. The Neo UI resets to
the first page whenever its search or analysis filters change.

The Neo callers debounce new searches, cancel obsolete requests, and retain
only the displayed result page. Failed first-page and navigation requests expose
a retry action; retry uses the failed request's cursor so a failed next page can
be retried without discarding the displayed page. Cursor history retains the
first page plus the latest 19 page cursors. Previous navigation is disabled
once an earlier cursor falls outside that window; the first-page action remains
available.

`count_desc` orders by message count descending, then normalized label. Search
uses `match_then_name`: an exact normalized-label match first, then normalized
label. The cursor stores the full order key, including exact-match priority, so
an exact match cannot cause later label-ordered results to be skipped.

## Exact-order work per page

The server prepares the effective analysis scope with the callsign facet
removed, then expands raw callsign variants, filters a nonempty search before
grouping, and calculates each normalized label's exact message count. For
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

There is no cross-request stored-result cache yet. A rejected ephemeral
label/count snapshot prototype remains external experiment evidence only; it is
not deployed or integrated. A cache that made later
count-ordered pages seekable would need to key results by every effective
filter and authorization scope, handle permission and data changes, coordinate
concurrent computation and cancellation, bound storage, expire safely, and
make expiry/recomputation explicit to callers. Until that lifecycle is
implemented, pages remain exact live keyset pages with bounded responses rather
than bounded database work.

## Local plan evidence and remaining validation gap

Production-builder measurements on an isolated synthetic fixture with
1.2 million messages and 100,000 normalized labels used alternating
baseline/candidate runs with three observations per query and page. Broad
first pages took 3.70–3.88 seconds before and 2.96–3.12 seconds after the
two-stage aggregation; broad later pages took 3.50–3.65 and 3.12–3.20 seconds.
Median execution time improved by 20% and 14%, respectively. These are
synthetic measurements without resetting PostgreSQL buffers. The new broad
plan still reads 2.28
million candidate occurrences, but reduces temporary I/O from 10,825 read /
10,836 written blocks to 2,025 / 3,140 by collapsing them to 120,570
label/spelling pairs before array construction. `match_then_name` retains its
previous shape: the label boundary excludes only labels that cannot occur on a
later page, while complete counts and variants remain calculated for retained
labels. It has not established a selective, bounded access path across the
large message and callsign relations; current plans still scan the complete
filtered message scope. Raw baseline and integrated captures remain outside the
repository under `/tmp/echo-3452-callsign-plans-20261007T082548Z`,
`/tmp/echo-3452-callsign-two-stage-integrated-20261007T135900Z`, and
`/tmp/echo-3452-callsign-paired-20261007T142759Z`. The paired capture retains
both an initial run with a sharp timing shift and the repeated comparison.
Raw statements and plans are kept outside the repository.

The ignored `capture_callsign_page_production_builder_plans` test captures
statements through the production builder. It requires the dedicated benchmark
database and `CALLSIGN_PLAN_OUTPUT` set to an output directory outside the
checkout; run it with the benchmark database selected through `TEST_DB_NAME`.

On 2026-10-06, the locally restored PostgreSQL 18 dataset contained 504,198
messages and 326,758 active callsign rows. A 60-day sample (2026-08-03 through
2026-10-03) contained 503,254 inbox items, but only 61 items and 24 normalized
callsign labels remained after the endpoint's active-message predicate. It is
therefore useful for checking the query shape, but is not representative of a
high-cardinality production catalogue. The rest of the restored history has
the same limitation: its busiest month has 271 active items and ten normalized
callsign labels.

`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` on that sample found:

- The legacy full-list query took 4.110 ms and returned 24 groups.
- Broad page browsing took 8.016 ms (cold-ish cache) and returned 24 groups;
  the grouped response was 2,152 bytes, or 902 bytes for a ten-entry page.
- A selective literal search took 3.619 ms; a subsequent ten-entry page took
  3.929 ms. Neither plan spilled to disk.

All variants used the same `signal_message_babak_candidate_stream_idx` scan,
then primary-key lookups into `sigint_inbox_item`, followed by the active
callsign item index. The keyset predicate was applied after grouping, so each
page still performed the aggregation and sort. `LIMIT` bounded the response
only; these measurements do not establish a backend speedup.

Production validation still requires plans from a 30--60-day dataset with a
representative active-message fraction, callsign-cardinality distribution, and
the real authorization/filter scope. Capture legacy and page broad-search,
selective-search, and subsequent-page plans with the same `EXPLAIN` options,
including scanned rows, buffers, aggregation/sort work, spills, execution time,
and response size.
