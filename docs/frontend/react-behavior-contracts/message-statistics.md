# Daily message statistics (#3873)

Route: `/message-statistics`. The footer of the shared Duty and Analysis group
navigation links to this page independently of AI-chat availability. The existing
last-hour activity page and Analysis activity chart retain their behavior.

The statistics surface follows the Echo desktop and mobile Figma frames
`4010:140182`, `4072:161958` and `4650:20481`: one compact filter toolbar,
one colored chart panel per user label, outlined grouping controls, and a combined
calendar-range control with independent "Сьогодні" and "7 днів" shortcut buttons.
These actions change only the date bounds (today, or today and the preceding six
days in Kyiv), preserve other filters, and have no selected/pressed state.
At narrow widths the shortcut buttons wrap below the calendar control to keep
the date bounds fully visible.
Each panel heading contains only
its label name; users without labels in the same organism have a separate panel. The shared filters and
existing group-access rules apply to every panel. There is no separate group sidebar.
See [user-label ownership and administration](../../message-statistics-user-labels.md).
Multi-day bars
are separated by day, with vertical series labels and dates below; a single
day uses horizontal series labels. The chart scrolls horizontally when its
labels would otherwise be squeezed, without widening the page. On first render,
each chart starts at the right end, showing the latest dates. Background refreshes
and viewport resizing preserve the user's scroll position. Series paging
sits below the chart card.

The card and plotting area keep the same height across periods, grouping modes,
loading, refreshes, empty results and errors. Both legend explanations reserve
their space; progress and notices do not move the plot or its baseline.

Filter buttons open separate panels with a search field, checkbox rows,
selection totals and a reset action scoped to that filter. Group rows display
distinct message counts for the selected period and the sender/unit filters;
their own group selection does not restrict the available group choices.
Unit choices use the shared hierarchy with independent expand and select
controls. Unit counts respect the selected groups and senders, exclude their
own unit selection, and count distinct messages across a subtree when child
inclusion is enabled. Duplicate unit links or messages shared by groups cannot
inflate those counts. Sender search and paging preserve selected identities.
Counts are loaded independently only while their panel is open. The catalog
contains group labels, the conditional hierarchy and selected sender labels;
it does not calculate period counters. Changing a facet's own selection does
not refetch that facet. Other filter changes clear its old numbers immediately
while retaining labels, selections and expanded branches. Sender discovery
returns labels and an exact total without calculating per-sender message counts.
Initial opening and pagination run immediately; search alone is debounced by
250 ms. Search does not change the available-sender total.
The unit panel also offers messages with no active unit link as "Не визначено".
Escape closes a panel and restores its trigger; arrow keys move between
checkboxes. Search keeps matching descendants visible with their ancestors.

The page requires the existing base analytics role. Every data and option request
resolves current group access, including organism ancestry restrictions, the
user's zone and secret-group membership. Admin uses the same scope. Selected
inaccessible groups do not widen the result. Panels, chart data and all filter
counts/options include only senders mapped to users of the viewer's exact current
organism, including for Admin. Users marked “Виключити зі статистики повідомлень”
in organism management are excluded from every period, including the unlabeled
panel, sender discovery, selected sender labels and all facet counts. Exclusion
is applied after canonical identity resolution and cannot disambiguate shared
aliases. Toggling the setting changes the cache access revision. Child organisms are excluded. Users without an
organism see an empty state; legacy endpoints obey the same data boundary.

Calendar dates are inclusive in Europe/Kyiv, with 1–90 days and no future dates.
The default is seven days including today. Database bounds are consecutive Kyiv
midnights converted independently to UTC. Only `signal_message.created_at`
determines the day; personal Analysis settings do not affect statistics.

Groups are identified by master key, senders by the group-association sender
with login-ID fallback. Echo UUIDs, Signal profiles and API sender aliases resolve
the author's current organism. Unknown, unmapped or ambiguous identities are
excluded; the importing user's organism does not override an external sender.
Within each day and series, message IDs and the opposite dimension are counted
distinctly after filters. Multiple unit links cannot multiply counts. Group
series include zero activity; sender series contain senders present in the
filtered interval. The graph is not a sum of unique messages across groups.

Unit selections use canonical linked-unit IDs from the shared hierarchy. Child
expansion is optional and initially enabled. An explicitly selected virtual
parent with no direct IDs yields no messages when children are disabled.
Existing Analysis/Duty descendant expansion is unchanged.

The URL owns dates and filter selections and supplies the initial grouping.
Each panel then owns its grouping and series cursors independently; changing shared
filters resets pagination while preserving its grouping, including when a panel
temporarily disappears because it has no activity. Returning to an earlier filter
starts on the first series page. Charts retain daily
resolution. Series pages contain ten entries, option
pages fifty, ordered by label and stable key. Bars have no navigation action.

Visible pages including today refresh every sixty seconds without overlapping
requests. Hidden pages do not poll statistics; focus/visibility recovery refreshes
stale data. Request replacement aborts old work and ignores late responses.
Metadata and panel discovery refresh every sixty seconds even for historical
periods; only open
filter panels poll their counters. The chart retains its existing today-only
refresh policy. A page-local cache holds at most 32 filter responses for five
seconds from their original generation time. It is cleared with labels and
visible data when current access changes. User identity and role changes remount
the React page, including transitions between users with identical roles.
Access and hierarchy revisions reject late responses from an obsolete scope.
Chart refresh failures retain the current result with a stale-data explanation;
401/403 remove statistics and cached filter data. Initial failures, empty access, empty results, and background
refresh states remain distinct and API errors use shared notifications.

Tests:

- `wdintel-rs/src/rer_importer/analysis/tests.rs`
- `wdintel-rs/src/rer_importer/analysis/daily_messages/cache.rs`
- `wdintel-rs/src/organism/tests.rs`
- `wdintel-web/src/ts/react/routes/message-statistics/__tests__/statistics-state.spec.ts`
- `wdintel-web/tests/e2e/message-statistics.spec.ts`
- `wdintel-web/tests/e2e/organism-user-labels.spec.ts`
