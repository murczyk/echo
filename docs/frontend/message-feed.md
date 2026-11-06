# Message feed implementation

Duty (`/rer-duty-neo`) and Analysis (`/rer-analysis-neo`) render messages through the same React `MessageFeed`. This page describes the current implementation, not the migration plan. [Message links](message-links.md) describes how a copied link selects and lands on a card.

## Ownership

`wdintel-web/src/ts/react/routes/shared/message-feed/` owns the native scroll container and message list, item registration, visible anchors, resize and window-change compensation, edge detection, focused positioning, and scroll cancellation. It renders the initial, refresh, and in-flow edge skeletons. `viewport/` handles geometry and preservation; `interaction/` handles reader input, edge loading, and tail following; `internal/` contains private state and scroll utilities. Hosts import the public API from `shared/message-feed/index.ts`.

Each host supplies messages in **display order** with stable IDs (numbers by default; `MessageFeed<T, Id>` also accepts strings, with `parseId` for the `data-message-id` fallback), its card children or `renderMessage`, loading and edge-availability flags, and `scrollOptions`. `MessageFeed` does not fetch messages, apply filters, own pagination, trim data, calculate unread counts, or choose card actions. Hosts compose the shared `MessageCard` and its actions inside the feed. The pure `shared/message-feed/windowing.ts` helper deduplicates and bounds arrays, but the hosts decide when to call it and what limit to use.

The scroller reports visible message IDs and first-visible position to its host. It exposes `scrollToMessage`, `scrollToBottom`, `getItemElement`, and `highlightLinkedMessage` through `MessageFeedHandle`. A mounted target can be positioned or highlighted; loading an absent target belongs to the host. `navigationTarget` aligns an already loaded page. A controlled `focus` keeps a target centered across layout changes until reader input releases it; the shared spacer lets boundary targets be centered.

## Loading and navigation

`isLoading` shows three shared skeleton cards when the list is empty. During refresh with existing cards, it shows a skeleton overlay without registering skeletons as messages. `hasMoreAbove` and `hasMoreBelow` add one in-flow skeleton card at each available edge, and entering a visible edge starts the corresponding host callback. `loadingAbove` and `loadingBelow` mark an active request; a newer edge is requested only once until the reader leaves and reaches that edge again, availability changes, or the host explicitly retries. The host must pass physical above/below availability and map those edges to its own chronological queries. The feed preserves a visible reading anchor when cards are prepended, removed, resized, or refreshed; changed windows arriving during active wheel scrolling are committed after scrolling settles.

The optional `newestNavigation` control accepts a physical `top` or `bottom` edge. The feed reports whether the viewport is at that edge. The host either supplies its own button (`renderControl`) or passes `onClick`, `newestLoaded` and optional `loading`, `label` and `className`, and the feed shows the shared arrow only when `onClick` is present; the host decides whether the true newest message is loaded. The optional `onCreateMessage` handler adds the create button under the arrow in the same floating stack (no handler, no button); `--message-feed-fab-right`, `-bottom` and `-top` move the stack. Reaching the end of a loaded chunk is not proof that the newest message has been reached. The linked-card outline stays visible briefly, then fades to transparent and clears after a two-second CSS animation. Reader scrolling does not cancel it early; a new chunk, manual refresh, or eviction still clears it. Reduced-motion users see a static brief outline followed by removal. `editorHighlightedMessageId` takes precedence while an editor opened from a card is active. Each mounted feed has independent scroll, loading, and highlight state.

Reply navigation requests smooth item focus. The shared scroll owner uses a
300 ms ease-out while continuing to reconcile the target position after layout
changes, so resize and next-frame centering do not interrupt the motion. Reader
input, a replacement target, eviction, or unmount cancels the transition; reduced
motion uses immediate positioning. Hosts still load bounded windows for distant
targets, and Duty constrains reply landings to actual content.

## Host policies

| | Duty | Analysis |
| --- | --- | --- |
| Initial position | Newest at the bottom, after settings are ready | Start of the selected display order |
| Ordering | Oldest to newest | User-selectable order, including newest first |
| Active message window | Up to 40 per column | Up to 40; pages contain 20 messages |
| Edge behavior | Older and newer chunks; watch/auto-follow and unread buffering | Both edges; physical direction maps to earlier/later by order |
| Page UI | No numbered message pages | Scroll changes the visible page index and URL; page controls navigate the same window |
| Extra state | 1–4 independent filtered columns; idle card offload in multi-column mode | Date/query filters, totals, explicit page jumps, and list inversion |

Duty data and policy live in `rer-duty-neo/` (`FeedColumnContent.tsx`, `useRerDutyFeeds.ts`, and related hooks). Analysis data and policy live in `rer-analysis-neo/` (`use-analysis-message-list.ts`, `components/useAnalysisMessageFeed.ts`, and `components/AnalysisMessagesPane.tsx`). Both hosts keep no more than 40 active messages by trimming the opposite edge as chunks arrive. The feed itself receives only the current window; it does not take a `maxMessages` prop. Duty's polling, unread state, pending newer buffer, and follow rules remain host-owned. Analysis retains its 20-message page model and current-page URL behavior, even though its active window is bounded.

For another consumer, supply its own data loader, ordered and bounded window, edge mapping, card rendering/actions, and optional feed policy. Reuse the shared scroller, skeletons, viewport navigation, and highlight API; do not copy those mechanisms into the host.

## Regression coverage

Shared component tests: `wdintel-web/src/ts/react/routes/shared/message-feed/__tests__/`. Host tests: `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/` and `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/`. Browser scenarios: `wdintel-web/tests/e2e/message-feed-unification.spec.ts`, `rer-duty-scroll-stability.spec.ts`, `rer-duty-workflows.spec.ts`, `analysis-neo.spec.ts`, and `analysis-workflows.spec.ts`. Run affected Playwright suites locally; E2E is not part of CI.
