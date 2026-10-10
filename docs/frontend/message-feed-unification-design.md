# Shared Message Feed: First-Stage Scope

Issue: [#3689](https://github.com/echoua/echo/issues/3689). Base branch: `main`.

## Outcome

Duty and Analysis use one `MessageFeed` and one viewport management core.
Measurements, position preservation, compensation for card height changes,
manual scroll handling, and target message positioning are maintained in one
shared location. Differences are expressed through settings and callbacks,
not by selecting between the two old implementations.

First, preserve current behavior. Duty's new copy-link behavior is the next
consumer of this foundation, not part of the first stage.
Search, Important message lists, replies, and mentions are not implemented now.

## Responsibility Boundary

`routes/shared/message-feed/` owns the native scroller, list, DOM element
registry, viewport snapshots, anchor restoration, target positioning,
ResizeObserver, cancellation of deferred operations, edge detection, and
protection against duplicate requests for the same edge. The component receives
`renderMessage` rather than reimplementing the shared `MessageCard`.

Duty retains polling, unread tracking, the pending buffer, counts, cursor
requests, the 40-message window, feed settings, audio, and notifications.
Analysis retains queries, filters, totals, page index, page accumulation,
sort order, and mapping physical edges to earlier/later requests.
The data source decides whether to replace or extend the array; the viewport
core compensates for the result regardless of the source.

## Policies That Retain Different Behavior

| Setting | Duty | Analysis |
| --- | --- | --- |
| Initial opening without a target | Bottom after settings load | Start of the current page |
| New cards | Follow only under current watch/auto-scroll conditions | Preserve the viewport, or the leading edge when refreshing at the top |
| Card set | Bounded window, maximum 40 | Accumulate loaded pages, page size 20 |
| Prefetch zone | Above 160px, below 640px | 480px at each edge in focused context |
| Bottom edge for UI | 25px; physical bottom is checked separately | Does not enable follow |
| Idle offload | Existing placeholders in multi-feed mode | Disabled |

Verify values and behavior against the code, not claims in the attached
documents. In particular, the canonical link uses `m`, not `msg`; Duty already
opens target message context but copies links to Analysis.
The current code's physical-bottom threshold differs from the document's 0.5px.
Do not silently correct such differences during extraction.

## Contracts

- Each message has a stable numeric id; the host determines array order.
- The host provides loading/availability for physical edges `above` and `below`.
- The core reports visible ids/the first visible id; the host calculates unread
  state or the current page.
- Snapshots support both prepend/trim and refresh/layout/remount.
- Target context loading remains in the host; `scrollToMessage` operates on an
  already mounted id and reports landing or a missing card.
- Explicit navigation takes priority over automatic follow; manual navigation
  cancels active target retention. Card button interaction is not treated as
  manual scrolling.
- When geometry prevents centering a target at the boundary, the core uses a
  shared spacer. Without a target, the spacer does not alter the ordinary feed.
- Loading/empty/error content, FAB, dialogs, and card actions remain
  host-specific slots or external components.
- Existing `data-duty-*` and `data-analysis-*` selectors survive migration.
- The shared core does not import from `rer-duty-neo` or `rer-analysis-neo`;
  diagnostics are injected through callbacks rather than coupling it to Duty.

## Migration Safety

Run existing E2E tests and investigate every failure before production
extraction. Characterization tests must establish actual current behavior;
fix a discovered defect or inaccurate test separately from structural changes.
Do not weaken assertions to conceal a baseline problem.

Preserve independence of 1–4 Duty feeds, mounting only the active feed on
mobile, reading anchors, loading at both edges, buffers/unread tracking,
focus, Analysis page navigation and list accumulation, card actions, state
after API errors, and existing message links. The native list structure must
not gain per-card MUI wrappers.

Completion criterion: both hosts use the shared component and viewport core;
the old Analysis scroll engine is removed, not hidden behind an adapter.
Data business processes remain separate, not DOM/geometry mechanics.
