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

`count_desc` orders by message count descending, then normalized label. Search
uses `match_then_name`: an exact normalized-label match first, then normalized
label. The cursor stores the full order key, including exact-match priority, so
an exact match cannot cause later label-ordered results to be skipped.
