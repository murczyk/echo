# Network Callsigns tab loading (#4047)

The tab loads the assigned callsigns and their activity separately, so a slow
activity query never blocks the list.

## List and stats stages

`POST /api/sigint/network-callsigns/list` with `include_activity_info: false`
reads only PostgreSQL. It ignores `period` and returns every assigned callsign.
Without that flag the endpoint keeps its activity-enriched behaviour, which the
classic page relies on.

The Neo page requests both forms at once and merges them by network-callsign
ID. The list always stays all-time. The period control only filters: a bounded
stats response lists only callsigns active in that period, so rows missing from
it fade out once it arrives. While stats load, or after they fail, rows stay and
the page does not show old numbers.

"Без обмежень" requests 21-day stats, labelled in the column headers. Real
all-time stats run only from "Статистика за весь час" in the callsign settings.
They are too slow for every page open. Measured for network 253 on 2026-11-06,
with 71 thousand links and a 35 million message-ID span: ClickHouse did not
finish within a 25-second test timeout, and PostgreSQL took 12.9 seconds cold.
The largest network exceeded a 15-second PostgreSQL timeout. A timeout on the
analytics route opens its circuit breaker, so an all-time default would have
moved these reads to PostgreSQL. Fast all-time stats need a pre-computed rollup.

The catalog and intercepted sections have no list separate from their activity:
their rows come from the same aggregate. `comp_freq_callsign` is not a safe
source for them because it has no group or organism scope and many organisms
share one zone.

## Message-ID bounds for a period

`load_message_id_bounds_for_period` used to walk the network's whole ID range in
1 million ID chunks, joining inbox items to messages in each. A long-lived
network needed dozens of sequential queries per request. It now makes one
`resolve_analytics_message_id_scope_for_range` lookup, which also deduplicates
concurrent requests.

The result is a superset for ID pruning, not exact bounds. The lookup filters on
bare `datetime`, while activity uses `COALESCE(datetime, timestamp, created_at)`
and about 7% of production inbox rows have a NULL `datetime`. Rows inside the
returned range are safe because the activity queries still apply the exact date
filter. To keep NULL-`datetime` rows inside the range, the window is widened by
`ANALYTICS_NETWORK_PERIOD_BOUNDS_MARGIN_DAYS` and rounded out to whole hours;
dated messages inserted around such a row bracket its ID. A row can only be
missed if its timestamp is more than the margin ahead of its insertion, or if
the whole instance has no dated messages for the margin next to the period. An
`Empty` scope prunes nothing, because NULL-`datetime` rows may still match.

Before the change, on the same day and host:

| Step | Measured |
|---|---|
| Assigned callsigns list, network 253 | 0.6 ms |
| One bounds chunk | 98 ms mean over 62 days; 202 ms in a single run |
| All 36 chunks, network 253 | about 3.5 to 7.3 s |
| Existing scope lookup | 636 ms mean over 313 thousand calls |
| Activity aggregate | 2.7 s mean, 19 s maximum |
| Each API request, end to end | 7 to 10 s, up to 19 s |

Both slow requests still run the same activity aggregate. Analytics saturation
also limits this page, as it does every analytics-backed page.
