# Duty Neo scroll & unread

Short guide for humans. Full behavior and acceptance scenarios:

→ **[archive/2026-08-09-duty-scroll-improvements/README.md](../../archive/2026-08-09-duty-scroll-improvements/README.md)**

Issue: [#3059](https://github.com/echoua/echo/issues/3059).

## Creation-time contract

Regression: [#3546](https://github.com/echoua/echo/issues/3546).

Duty Neo always uses message creation time. This is a feed invariant, not a user
preference. Analysis alone retains the event/creation-time choice; its saved
`messageSortBy` setting must never change or reload Duty feeds.

- Every Duty inbox/count request uses `IMSCreatedAt`, including date filters,
  initial/direct-link loads, older/newer pages, polling, and notification previews.
- Feed order is ascending `(signal_message.created_at, id)`, newest at the bottom.
  Local sorting, pagination/unread cursors, pending buffers, and notification
  selection use `createdAtOrder` (microseconds), falling back only to
  `createdAt * 1000` for older payloads. Event time is never an ordering fallback.
- Cards use creation time for the primary/relative time display. Event dates remain
  message metadata; editing an event date cannot move a card in the feed.
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
- **Scroll-idle newer loads:** when not physically at the bottom, `onLoadNewer` waits ~140ms after the last scroll event so a mid-fling fetch does not commit a 40-card window trim under the user’s finger.
- **Badge** = loaded unread + trimmed unread + (beyond-tail preview when known). Near bottom **ignores** residual poll stock from a lagging read cursor; it **keeps** a real matching tail preview.
- Mid-list read cursor advances from **DOM viewport-visible** rows. At bottom still marks through the **window tail** id.
- Near bottom without watch: keep loading newer until there are **≥10 loaded-unread after last-seen** (or the server is exhausted). Watch + physical bottom still mark-all-read and drains the live tail.
- **Pending newer buffer** (Elm `notRenderedMessagesYet`): background results that could evict visible rows remain pending. Native scrolling commits the longest safe ordered prefix while preserving the visible anchor; the down-arrow may then navigate and land on the current tail. Pending tails detached by an older-window trim are discarded and re-fetched from the retained boundary.
- **Active-only card trees (narrow):** narrow multi-feed mounts MessageCards only for the active tab.
- **Idle viewport offload (multi-feed):** after ~10s without pointer/wheel/touch on a feed, off-viewport rows in that column become height placeholders; interaction remounts the full 40-window. All columns stay visible.
- **Collapsed media (Duty, [#3161](https://github.com/echoua/echo/issues/3161)):** optional setting (default of) hides audio / photo·video / coordinates behind a reveal banner until clicked. Toggle in Settings → Оперативний.
- Arrow down: explicit load (if needed) → one landing → hard unread catch-up. It does not authorize later background following. FAB shows a spinner while newer `get-inbox` is in flight.

## Do not

- Derive unread from `loadedTailId - cursorId` (IDs are not dense under the filter).
- Write inbox `quantity` straight into the badge while near bottom.

## Code map

| Concern                                          | File                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Zones, load arming, anchor restore               | [`useWindowedFeedScroll.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useWindowedFeedScroll.ts)                       |
| Duty buffers (640 / 160 / 25)                    | [`FeedColumnContent.tsx`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/FeedColumnContent.tsx)                             |
| Near-bottom badge options, reach-bottom / follow | [`index.tsx`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/index.tsx)                                                     |
| Poll catch-up, cursor, `catchUpFeedUnreadToTail` | [`useRerDutyFeedState.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeedState.ts)                           |
| Newer/older loads, trim read rules               | [`useRerDutyDirectionalLoads.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyDirectionalLoads.ts)             |
| Window limit, badge formula, prefetch min        | [`utils.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/utils.ts)                                                       |
| Arrow catch-up                                   | [`useRerDutyFeedInteractionActions.ts`](../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeedInteractionActions.ts) |

## Full doc

- Spec (complete): [Duty scroll improvements archive README](../../archive/2026-08-09-duty-scroll-improvements/README.md)
