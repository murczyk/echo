# Duty Neo scroll & unread

This is a short summary of duty scroll implementation spec. Full behavior, edge cases, and acceptance scenarios:

→ **[archive/2026-08-09-duty-scroll-improvements/README.md](../../archive/2026-08-09-duty-scroll-improvements/README.md)**

Issue: [#3059](https://github.com/echoua/echo/issues/3059).

## What you need to know

- Each column keeps a **40-message window**. Older prepends / newer appends trim the other end.
- **Near bottom** ≈ within **640px** of the end, **or** (when unread prefetch is still needed) the viewport has reached the **last 10** mounted rows. That zone drives newer prefetch and how the badge treats poll residual.
- **Badge** = loaded unread + trimmed unread + (beyond-tail preview when known). Near bottom **ignores** residual poll stock from a lagging read cursor; it **keeps** a real matching tail preview.
- Near bottom without watch: keep loading newer until there are **≥10 loaded-unread after last-seen** (or the server is exhausted). Watch + physical bottom still mark-all-read and drains the live tail.
- Arrow down: load (if needed) → follow → hard unread catch-up. FAB shows a spinner while newer `get-inbox` is in flight.

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
