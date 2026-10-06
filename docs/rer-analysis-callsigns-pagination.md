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

## Local plan evidence and remaining validation gap

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
