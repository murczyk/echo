# Shared message feed

Duty and Analysis compose cards inside `MessageFeed`. The component owns the
native scroller/list, the shared card skeleton, item registration, visible
anchors, resize compensation, edge detection, follow, focused positioning,
page alignment, and cancellation. Neither imports a host.

## Package boundary

Host code imports components, navigation helpers, and public contracts
from `shared/message-feed`. The package entry point is `index.ts`; hosts must not
import files from the implementation directories directly.

- `viewport/` owns anchors, focus geometry, layout compensation, viewport
  preservation, settling, and spacer state.
- `interaction/` owns reader input, scroll events, position tracking, and live
  tail following.
- `internal/` owns mutable refs, diagnostics adapters, private hook contracts,
  constants, and scroll geometry helpers.
- `__tests__/` verifies the package API and shared feed behavior. Host-specific
  tests remain beside Duty and Analysis.

## Host contracts

- Supply stable numeric ids in display order. Keep data fetching, request
  generations, errors/toasts, pagination and window trimming in the host.
- Map physical above/below edges to chronological requests. Analysis reverses
  this mapping when newest-first is selected; Duty always shows newest last.
- Retain card memoization and offload placeholders through `renderMessage` or
  `MessageFeedRows`. Slots and native attributes preserve host presentation.
- Render native card wrappers through `MessageFeedItem`, or use `data-message-id`
  with the component registry. Duty retains `data-duty-message-id` for existing tools.
- Pass `scrollOptions` for feed policy, edge callbacks, focus, and reset keys.
  Pass `isLoading` for initial and refresh card skeletons. Pass
  `hasMoreAbove`/`hasMoreBelow` for in-flow edge skeletons: entering the visible
  scroller starts the corresponding page request. `loadingAbove`/`loadingBelow`
  mark an available skeleton as loading and gate duplicate requests; background
  fetches without an available page do not add a skeleton.
  Each mounted feed owns independent scroll and loading state.
- Use the `MessageFeedHandle` ref's `scrollToMessage` for a mounted target and
  `scrollToBottom` for tail landing. Call `highlightLinkedMessage` after a
  linked target mounts. Its outline survives reader scrolling and clears when
  a new chunk or manual refresh commits, or when the card leaves the window.
  Pass `editorHighlightedMessageId` while a card action owns an open editor;
  it takes precedence over linked highlighting and clears when the editor closes.
  Each feed owns its own highlight state, including Duty's separate columns.
- Pass `newestNavigation` only on feeds that need a jump-to-newest control.
  Its `edge` is `top` for newest-first lists and `bottom` for oldest-first
  lists; `renderControl` receives whether the viewport is at that physical
  edge. The host supplies its own button and confirms whether the newest
  message is actually loaded before hiding it. A loaded chunk boundary alone
  is not the newest-message boundary.
  The host loads missing context first and wakes any offloaded viewport.
  Navigation owners provide generation/current checks and landing callbacks.
- A controlled `focus` retains centered positioning through layout changes.
  Reader scroll input releases it; card actions do not. The shared bottom
  spacer makes boundary targets centerable. Hidden viewports wait for geometry.
- `navigationTarget` aligns a loaded page at the leading edge; it does not fetch.
  `onFirstVisibleMessage` lets hosts calculate page indicators or unread state.
- Capture before refresh with `onViewportCaptureChange`; increment
  `viewportPreservationKey` to restore the leading/trailing edge or reading card.
  `resetKey` cancels old viewport work. `positionResetKey` resets page landing,
  except when `preservePositionOnReset` marks an accumulated page.
- Inject optional diagnostics. Debug stores remain host-owned.

## Policies

| Policy | Duty | Analysis |
| --- | --- | --- |
| Initial position | End after settings arrive | Start |
| Follow at bottom | Existing watch/auto-scroll gates | Disabled |
| Fallback edge buffers and near-bottom tracking | 160 / 640px | 480 / 480px |
| Below-edge strategy | Scroll idle, expanded unread runway | Immediate, fixed buffer |
| Underfilled input loading | Enabled | Disabled |
| Resize during below-edge load | Defer transient append compensation | Preserve the reading anchor |

The 25px UI-bottom threshold is not physical-bottom permission to follow.
Visible edge skeletons take precedence over buffer-based page loading. Duty's
background unread prefetch continues to use its existing near-bottom policy;
an evicted newer tail retains the bottom skeleton while fetched cards remain
buffered outside the visible window.
`deferResizeWhileLoadingBelow` retains Duty's append behavior; Analysis disables
it so media/editor height changes remain compensated during a page request.
Released focus retains only spacer height needed to avoid clamping the reader;
scrolling away or adding real content removes surplus space.
Duty retains its 40-card window and idle offload; Analysis retains accumulated
20-message pages. These data policies are not implemented by the viewport.

## Verification and next stage

Shared integration tests live in
`wdintel-web/src/ts/react/routes/shared/message-feed/__tests__/MessageFeed.spec.tsx`.
Host coverage remains in
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useWindowedFeedScroll.spec.tsx`
and `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`.
Browser coverage is in `wdintel-web/tests/e2e/message-feed-unification.spec.ts`,
`wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`,
`wdintel-web/tests/e2e/rer-duty-workflows.spec.ts`,
`wdintel-web/tests/e2e/analysis-neo.spec.ts`, and
`wdintel-web/tests/e2e/analysis-workflows.spec.ts`. Run browser suites separately
from frontend generation/builds to avoid dev-server reloads during navigation
assertions.

Copied links keep their host-specific destinations. Search, Important lists,
replies and mentions can reuse the feed's mounted-target navigation and
highlighting without adding another scroll implementation.
