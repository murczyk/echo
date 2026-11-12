# Duty Neo scroll & unread

Short guide for humans. Full behavior and acceptance scenarios:

→ **[archive/2026-08-09-duty-scroll-improvements/README.md](../../archive/2026-08-09-duty-scroll-improvements/README.md)**

Issue: [#3059](https://github.com/echoua/echo/issues/3059).

## Creation-time contract

Regression: [#3546](https://github.com/echoua/echo/issues/3546).

Duty Neo always orders and filters by message creation time. This is a feed
invariant, not a user preference. Analysis alone retains the event/creation-time choice; its saved
`messageSortBy` setting must never change or reload Duty feeds.

- Every Duty inbox/count request uses `IMSCreatedAt`, including date filters,
  initial/direct-link loads, older/newer pages, polling, and notification previews.
- Feed order is ascending `(signal_message.created_at, id)`, newest at the bottom.
  Local sorting, pagination/unread cursors, pending buffers, and notification
  selection use `createdAtOrder` (microseconds), falling back only to
  `createdAt * 1000` for older payloads. Event time is never an ordering fallback.
- Cards always show the message's event date/time in the header, independently of
  sorting. Their system creation-time footer uses `createdAt`: `HH:mm` today,
  `DD.MM, HH:mm` on other dates this year, and `DD.MM.YYYY, HH:mm` in other years
  (Kyiv calendar). The header date always includes the year; date-only events
  omit the time. Event dates remain message metadata, and editing an event date
  cannot move a card in the feed.
- The sorting chooser exists only under Settings → Analysis. Existing Analysis
  preferences and its shared API/storage field are preserved.

Acceptance scenarios covered by the #3546 regressions in `test:ts:ci`:

1. Event time, creation time, and IDs disagree: initial and paginated windows stay
   in creation order, including equal timestamps and distinct microseconds within
   one displayed millisecond.
2. A newly created message with an old event date enters the live tail, contributes
   to unread state, survives pending-buffer commits, and is eligible for notification.
3. Updating event metadata does not reorder messages or corrupt unread cursors.
4. Loading or changing Analysis's preference does not reload or change Duty; the
   Analysis chooser still saves and controls Analysis.

Preserve this contract when changing shared settings, MessageCard, inbox requests,
or Duty scrolling/unread behavior. Run its CI regressions alongside the affected
scroll, direct-link, and Analysis checks.

Scroll/commit performance notes (Virtuoso rollback, profile, next levers):
[`archive/2026-08-12-duty-feed-scroll-perf/README.md`](../../archive/2026-08-12-duty-feed-scroll-perf/README.md).
Cheap closed actions, `startTransition` window commits, and narrow active-only feed mounts are covered there.

Implementation plan (active-only desktop → pending soak → cheap cards → optional TanStack):
[`archive/2026-08-13-duty-scroll-perf-plan/README.md`](../../archive/2026-08-13-duty-scroll-perf-plan/README.md).

## What you need to know

- Each column keeps a **40-message window**. Older prepends / newer appends trim the other end.
- **Near bottom** ≈ within **640px** of the end. If unread prefetch is still needed, the load zone expands up to about **two viewports** (capped at `2×640`), not “last 10 tall messages” (that fired loads thousands of px early and froze scroll on window trim).
- **Scroll-idle newer loads:** background unread prefetch waits ~140ms after the last scroll event when not physically at the bottom, so a mid-fling fetch does not commit a 40-card window trim under the user’s finger. An available newer-page skeleton loads immediately when it enters the viewport.
- **Edge-load visual commit:** when a new window arrives during wheel input, the feed keeps the current cards and edge skeleton until wheel and inertial scroll events are idle for ~140ms. Wheel input remains available throughout. This is shared with Analysis.
- **Badge** = loaded unread + trimmed unread + (beyond-tail preview when known). Near bottom **ignores** residual poll stock from a lagging read cursor; it **keeps** a real matching tail preview.
- Mid-list read cursor advances from **DOM viewport-visible** rows. At bottom still marks through the **window tail** id.
- Near bottom without watch: keep loading newer until there are **≥10 loaded-unread after last-seen** (or the server is exhausted). A physical bottom in a linked historical window is only a chunk boundary, not the live tail: it must not enable watch or drain later chunks automatically. Watch + physical bottom at the true newest edge still mark-all-read and drain the live tail.
- **Pending newer buffer** (Elm `notRenderedMessagesYet`): background results that could evict visible rows remain pending. Native scrolling commits the longest safe ordered prefix while preserving the visible anchor; the down-arrow may then navigate and land on the current tail. Pending tails detached by an older-window trim are discarded and re-fetched from the retained boundary.
- **Active-only card trees (narrow):** narrow multi-feed mounts MessageCards only for the active tab. Editor resizing and tab remounts preserve each feed’s reading anchor; delayed scroll and idle callbacks wait for pending layout restoration. Regression coverage: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx` and `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`.
- **Idle viewport offload (multi-feed):** after ~10s without pointer/wheel/touch on a feed, off-viewport rows in that column become height placeholders; interaction remounts the full 40-window. A feed width change (embedded editor open/close, window resize) also remounts it, because placeholder heights are only valid at the width they were measured at. All columns stay visible.
- **Collapsed media (Duty, [#3161](https://github.com/echoua/echo/issues/3161)):** optional setting (default of) hides audio / photo·video / coordinates behind a reveal banner until clicked. Toggle in Settings → Оперативний.
- Arrow down: explicit load (if needed) → one landing → hard unread catch-up. It does not authorize later background following. The button stays visible at a chunk boundary until the newest message is confirmed and rendered. Only an explicit jump shows a spinner in the button; ordinary chunk paging uses the feed skeleton.
- **Underfilled window fallback ([#3615](https://github.com/echoua/echo/issues/3615)):** when the mounted window does not overflow, a deliberate upward wheel or focused Up/PageUp requests older history; a downward wheel or focused Down/PageDown flushes buffered newer items or requests a newer page. It never runs on mount, never drains history automatically, ignores nested controls and modified/zoom input, and coalesces input until the directional attempt settles. Native scrolling remains the owner once the window overflows. Regression: `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts` and `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx`.

## Do not

- Derive unread from `loadedTailId - cursorId` (IDs are not dense under the filter).
- Write inbox `quantity` straight into the badge while near bottom.

## Polling and live updates

Automatic counts use `rer_duty_poll_interval_sec` (minimum/default five seconds),
including focus/online/visibility recovery. Per feed, a new automatic count
waits for the configured interval since its previous count start and for active
unread/tail count requests to settle. Polls blocked by an active tail count retry
when it settles, while preserving the configured interval. Slow feeds do not
block healthy feeds.
Explicit initial loads, filter changes, and navigation remain immediate.

Changing a feed filter clears its previous message window, buffered messages,
and unread state before loading the new results. A failed reload shows an error
without displaying messages from the previous filter. Edit refreshes with unchanged
filters preserve the current window. Regression:
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.initial-load.spec.tsx`.

Inbox events hydrate changed displayed and buffered messages without starting
extra count polls. Buffer updates preserve the displayed window; identical
payloads preserve message references to avoid unnecessary card reconciliation.
Reply metadata follows the [message reply refresh contract](../message-replies.md#rendering-and-refresh):
events invalidate citations, and admitted polling cycles reconcile them without
starting extra counts. Citation timestamps always use creation time on Duty.
Reuse an unread count for the loaded-tail boundary only when filters,
cursor, and request generation match; different boundaries retain separate
answers. For six loaded unread messages and three unloaded newer messages,
the unread count is nine and the tail count is three.

The default-suite regressions are
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx`
and `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeeds.spec.ts`.
Classic Duty also uses the existing interval setting and filters event IDs
against displayed and buffered messages before fetching updates. Its buffer
refresh regression is `wdintel-web/tests/RerDutyRefreshRegressionTests.elm`.
Each Classic waterfall has one polling subscription, removed with the waterfall
or page. Automatic requests respect the interval between starts and wait for
active count/message requests. Blocked polls retry after those requests settle,
including failures, while preserving the interval between starts;
scroll-to-latest reloads do not start another
polling loop. Classic Duty receives inbox changes through Shared's event
transport, including updates to buffered messages. Browser regressions are in
`wdintel-web/tests/e2e/rer-duty-polling.spec.ts`.

## Search and older periods

The «Пошук в оперативному» toggle in admin system settings enables the Analysis
search control below saved filters in every Duty Neo column without a server
restart. The default is false; both search and the older-period button are
hidden when disabled. Reload Duty after changing the setting. Existing
`enable_duty_search` values in `config.toml` are imported at startup only when
the database setting is unset; the legacy key can then be removed.
Search text and mode belong to the column filter and saved/linked filters.
Search, counts, and all pages use the column filters and creation time.
Inbox events recheck search membership for displayed, buffered, and off-window
unread messages. Messages that stop matching are removed from all three.
If server settings fail to load, a toast reports the error and restored searches
remain blocked until the page is successfully reloaded.

The initial request keeps the adaptive limit: traffic above 100,000 messages
in the preceding three days, unit filters, or unavailable statistics restrict
history to 14 days. The effective boundary is applied before choosing the
PostgreSQL/analytics search route and returned with the response. Subsequent
pages keep that boundary. After exhausting it (including an empty result),
«Завантажити ще» searches the preceding period of the same length. Empty periods
advance the boundary too; failures leave it available for retry. Each click
queries only the next period and retains already loaded results within the
40-message window. Adjacent periods share their inclusive boundary to preserve
creation times between milliseconds; cursors and deduplication prevent repeats.
Changing filters resets the history boundary. When the
adaptive limit is unnecessary, the initial search covers all history and there
is no earlier period to load.
Reconciliation that changes the oldest result discards an in-flight older page
without advancing the period or blocking retry. Counts from a previous history
boundary are discarded as well.

Regression coverage:
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.search.spec.tsx`
and `wdintel-web/tests/e2e/rer-duty-search.spec.ts`.

## Independent search panel

[#3571](https://github.com/echoua/echo/issues/3571): when `enableDutySearch` is enabled,
each column has a separate search action. Only one panel is open at a time. The
lightweight results use the feed's filters and server search modes, creation-time
ordering, paged cursors, and a separate total count. The default period covers all
available history. The panel has no separate history-period control.
An upper timestamp bounds both result and count requests, including all-history
search. Search text never changes the main feed, its polling, or unread tracking.

Selecting a result explicitly navigates its source feed using the existing linked
message context/highlight flow and cancels live following. The panel stays open.
Closing or switching panels retains query, mode, period, results, selection and
list anchor within the current page; reopening refreshes without repeating feed
navigation. Closed panels make no background search requests. Filter changes
invalidate cached results, while preserving the query. Stale responses cannot
replace a newer query or navigate the feed.

Group navigation and search are mutually exclusive within a column: opening
either closes the other while preserving the source feed's reading position.
Switching to groups retains the search cache and moves focus to the selected
group; it does not restore focus to the closed search trigger. Explicit close
returns focus to the corresponding trigger. Search in one column can coexist
with group navigation in another. Choosing a different group uses normal scope
navigation and invalidates cached search results while retaining the query.

Open panels refresh on batched inbox-change events, including arriving messages
and edits/deletions. Idle feed polling and browser focus do not fetch search
results or show a loading indicator. Server matching-filter checks reconcile
edited/deleted cached results.
Refreshes page through the oldest cached cursor to reconcile the loaded range
without leaving burst gaps. Historical readers keep their visible row and
selected result; new matches wait behind an explicit indicator. The result list
never marks messages read and never mounts another MessageCard/media tree.
Failed refreshes retain the cache; error/retry feedback appears in the page
snackbar, outside the result panel.

Desktop search adds a 270px track to the left of its source feed, below a shared
full-width column header, with horizontal overflow. Results show group, sender,
creation time and an emphasized matching snippet. Sibling feed widths remain
stable. Selecting a result jumps to its message without animated scrolling,
retaining the surrounding feed context. Narrow/editor active-only layouts still mount
one feed and preserve its source width. Explicit close returns keyboard focus to
the source search action. Search popups own Escape before the enclosing panel.
The existing feed keyword filter remains **«Фільтр по ключовому слову»**. Applying
a nonempty keyword closes the separate panel and disables its action until the
keyword is cleared; clearing never reopens it automatically. Analysis search
controls and behavior are unchanged. Duty mode selection uses the same
autocomplete dropdown interaction as Analysis. In the search panel, the
«Як працює пошук» link below its three mode options opens the explanation on
request. Keyboard users can reach it with Tab; closing the explanation restores
input focus without closing search. The keyword filter retains its information
button. Close the search panel with its header action or Escape; the result
navigation row contains only the previous/next arrows.

Regression coverage:
`wdintel-web/tests/e2e/rer-duty-search.spec.ts` and
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useDutySearch.spec.tsx`.

## Code map

| Concern                                          | File                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Zones, load arming, anchor restore               | [`useWindowedFeedScroll.ts`](../../wdintel-web/src/ts/react/routes/shared/message-feed/useWindowedFeedScroll.ts)                       |
| Duty buffers (640 / 160 / 25)                    | [`FeedColumnContent.tsx`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumnContent.tsx)                             |
| Near-bottom badge options, reach-bottom / follow | [`index.tsx`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/index.tsx)                                                     |
| Poll catch-up, cursor, `catchUpFeedUnreadToTail` | [`useRerDutyFeedState.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeedState.ts)                           |
| Newer/older loads, trim read rules               | [`useRerDutyDirectionalLoads.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyDirectionalLoads.ts)             |
| Window limit, badge formula, prefetch min        | [`utils.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/utils.ts)                                                       |
| Arrow catch-up                                   | [`useRerDutyFeedInteractionActions.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeedInteractionActions.ts) |

## Count-request diagnostics

React inbox and Analysis requests carry a loaded asset identifier, an ephemeral
ID for the current browser document and its visibility state. Duty Neo's unread
count requests also identify automatic, manual and validation triggers. These
headers are retained in request activity; diagnostic values over 128 bytes are
ignored. They contain no filter contents or credentials, are not authentication
inputs, and do not persist across document reloads. Use them to attribute repeat
counts before changing the configured polling interval; preserve unread discovery
and notifications for hidden tabs.

## Full doc

- Spec (complete): [Duty scroll improvements archive README](../../archive/2026-08-09-duty-scroll-improvements/README.md)
