# Message Feed Composition and Loading Design

**Status:** Approved for implementation planning  
**Issue:** [#3689](https://github.com/echoua/echo/issues/3689)  
**Base branch:** `main`

## Intent and scope

This is the second, incremental step of the existing feed unification. Duty and
Analysis already use the same `MessageFeed` renderer and `useWindowedFeedScroll`
engine. The remaining public composition should let each page supply ordered
messages, card content, loading state, and pagination callbacks while each
`MessageFeed` instance owns its scrolling, item registration, positioning, and
feed-card skeleton. One to four Duty columns must remain independent.

This step does not change copied-link destinations or add new navigation
sources. The next step will make a Duty card copy a Duty link while an Analysis
card continues to copy an Analysis link; both will use the same feed navigation
behavior. Search, Important lists, replies, and mentions remain later work.

## Current constraints

- Both hosts call the shared scroll hook outside `MessageFeed`. Duty also uses
  its scroller for idle card offload and an imperative scroll FAB; Analysis uses
  the scroller for diagnostics and target highlighting.
- Duty renders a memoized list with native per-card wrappers and optional
  height placeholders. Analysis renders shared `MessageCard` roots as list
  items. Do not introduce an extra per-card MUI wrapper or defeat Duty's
  memoization and 40-card window.
- Initial Duty and Analysis skeletons are currently hosted in page shells;
  Analysis refresh and focused-context skeletons are separate. Existing
  staged Analysis skeleton edits must be preserved and integrated, not lost.
- Page data lifecycles differ: Duty polls and tracks unread/pending items;
  Analysis accumulates pages and can reverse their display order. Neither
  lifecycle belongs in the shared feed.

## Component boundary

`MessageFeed` owns the native scroller and list, invokes the existing shared
viewport hook, registers mounted message elements, handles edge events and
target alignment, and renders the common feed-card skeleton for initial,
refresh, and edge loading. The shared hook remains a private implementation
unit and keeps its current viewport behavior; the migration must not create a
second scroll engine.

Each host owns fetching, filters, ordering, page/window composition, loading
and error state, empty-state copy, card actions, column/tab shells, diagnostics
configuration, and navigation context loading. The host passes actual cards as
children (including Duty's memoized list and offload placeholders), not a
feed-owned action schema. The feed never imports either host or the card action
implementations. Shared `MessageCard` variants remain responsible for card UI.

The public component contract is conceptually:

```tsx
<MessageFeed
  items={messages}
  getMessageId={getMessageId}
  scrollOptions={pageScrollPolicyAndCallbacks}
  isLoading={messagesLoading}
  loadingAbove={loadingAbove}
  loadingBelow={loadingBelow}
  ref={feedRef}
>
  {pageOwnedCards}
</MessageFeed>
```

`items` determine the ordered numeric IDs used by viewport management;
`children` determine the card markup. They must describe the same messages,
including offloaded placeholders. A render callback can remain as a supported
convenience, but neither host must use it. Existing native scroller/list
attributes and host-only slots remain available without encoding a page name
inside the shared feed.

`scrollOptions` groups policy, edge availability/loading, and callbacks from
the existing hook contract; the feed derives `itemIds` itself. It must keep
the existing Duty and Analysis policy values, reset/preservation keys, focus,
and cancellation semantics. The host may observe the scroller for offload or
diagnostics but must not implement scroll geometry. A narrow imperative feed
handle provides `scrollToBottom`, `scrollToMessage`, mounted-item lookup, and
read-only scroller access for existing FAB, offload, highlighting, and debug
consumers. The host can wake offloaded cards before asking the feed to land.

DOM item registration must be ready before an explicit landing. Preserve
existing `data-duty-*`, `data-analysis-*`, and `data-message-id` selectors and
native list semantics. If Duty needs a registration helper for its existing
wrapper, that helper belongs in the shared package and adds no extra DOM node.

## Loading and errors

The host passes `isLoading` for initial or replacement loading, and separate
physical `loadingAbove` / `loadingBelow` flags for pagination. `MessageFeed`
renders the same transparent-background card skeleton in both routes. Initial
loading with no items shows skeleton cards; refreshing an existing list covers
the cards without replacing their DOM or losing the reading anchor. Edge
loading shows a small skeleton group at the corresponding edge. Skeletons are
not message items and must not enter ID, anchor, unread, or page calculations.

Duty's column-header skeleton and Analysis's tabs/right-panel skeleton remain
in their page shells, but both reuse the shared feed-card skeleton for the
message area. Empty and error content remains host-owned. Pagination callbacks
are reported to the host; the feed never calls an API, retries a request, or
swallows an error. Hosts retain their existing user-facing error toasts.

## Independence and behavior preservation

Each mounted `MessageFeed` has its own hook instance, refs, pending navigation,
edge-request protection, and loading indicators. A change in one Duty filter
or column must not reset, fetch, or scroll its siblings. Mobile Duty continues
to mount only the active feed. Analysis continues to support both sort
directions, page alignment, accumulated pages, and focused context. Duty
continues to support watch/follow, unread buffering, idle offload, pending
newer items, and an imperative FAB. Card actions remain unchanged.

## Verification

Start from the existing Vitest and Playwright characterization coverage.
Add shared component tests for children composition, skeleton states, item
registration/landing, and two independent feed instances. Adapt host tests to
the new component contract, then run the complete frontend test/build commands
and the affected Duty/Analysis Playwright suites. Do not weaken a behavior
assertion to conceal a regression; investigate failures before migrating the
next host. Verify that staged Analysis skeleton work is preserved in the final
diff.

The step is complete when both hosts use the component-owned viewport and
shared feed-card skeleton, no host calls `useWindowedFeedScroll` directly,
and all data/business/card-action responsibilities remain host-owned.
