# Bounded Analysis Message Window Design

**Status:** Pending review

**Issue:** [#3689](https://github.com/echoua/echo/issues/3689)

**Base branch:** `main`

## Intent and success criteria

Keep the Analysis message feed bounded in the same way as Duty. Scrolling through
arbitrarily many chunks must not keep adding message cards or `InboxMessage`
payloads to the active window. The default limit is 40 messages, with a 20-message
API page; the limit is a page-data configuration, not a `MessageFeed` prop.
Both regular browsing and direct-message navigation obey the limit, regardless
of Analysis sort direction. The existing `loadAllMessages` path must no longer
install an unbounded response in the feed.

The user can still revisit evicted messages by scrolling in either direction,
use the existing Analysis page controls and copied-message links, and keep the
same reading position as a chunk enters or leaves the window. The feed
continues to show its existing edge skeletons while these requests run. A
scrollbar thumb may vary with card height, but its length must not continually
shrink because of accumulated message cards. Analysis's page-based navigation
is preserved; it is not replaced by Duty's navigation model.

## Existing behavior and architectural choice

Duty limits its active message array to 40 and evicts the opposite edge after
directional loads. Analysis currently appends every regular page and also grows
both sides of a focused message without a limit. Its page-coordinate helper
infers the first loaded page from `messages.length` and the last loaded page;
that inference is not sufficient once either edge can be evicted.

Three approaches were considered:

1. **Bound page-owned data with shared window operations (chosen).** Both hosts
   use the same pure merge/deduplicate/trim rules, while each host owns its API
   cursors, filters, loading state, and special business data. This bounds
   React state and mounted cards without moving fetching into `MessageFeed`.
2. Add a `limit` prop to `MessageFeed` and slice its children. This bounds only
   rendered nodes: the Analysis page still retains all message payloads, and
   the feed cannot decide which evicted edge can be fetched again.
3. Virtualize all accumulated Analysis messages. This bounds DOM nodes but
   leaves message payloads and page state unbounded and changes viewport
   behavior more broadly than needed.

This design supersedes the previous composition spec's statement that Analysis
accumulates pages. It does not change that spec's ownership boundary: the page
still supplies ordered items and cards to the shared `MessageFeed`.

## Ownership and data flow

The shared message-feed package owns pure, order-preserving window operations.
Given ordered current items, an ordered incoming page, the loading edge, an ID
selector, and a configurable limit, it returns the retained items and which
items entered and left the window. Duplicate IDs appear once. The operation
evicts from the edge opposite the load; it never resorts by ID. Duty keeps its
existing timestamp ordering and unread/pending reconciliation around this
shared operation. Analysis keeps its API ordering and page/cursor semantics.

Each page passes its chosen limit (40 for Duty and Analysis) to that operation
through its data owner. `MessageFeed` receives only the bounded messages and
physical-edge availability/loading callbacks. It does not store hidden
messages, choose API cursors, prune application state, or interpret a page
number. Its existing scroll anchoring and skeleton rendering remain shared.
No `windowLimit` prop is added to the visual component.

## Analysis window and navigation

Analysis tracks the loaded window's logical first and last message/page
coordinates independently of `messages.length`. The current visible page,
the toolbar/URL page index, and the loaded window boundaries remain distinct.
The page-relative position of a mounted message is computed from those explicit
coordinates; it is not reconstructed by assuming that all earlier pages remain
in memory. A focused link similarly retains its absolute target index even if
the target later leaves the active window.

Initial regular loading starts with at most one 20-message page. Loading the
next page extends the window until it reaches 40, then removes the opposite
edge. Returning through the other edge fetches its page again and removes
messages from the far edge. Both physical edges can offer pagination after
eviction. For newest-first display, physical top/bottom map to the appropriate
chronological request; for oldest-first display, the mapping reverses. The
same limit and directional eviction apply around a focused message.

The page owner distinguishes a server-exhausted edge from an edge that can be
revisited because items were evicted. A successful empty response exhausts
only the requested edge for the current query/cursor; an error does not mark
the edge exhausted. Request generations prevent late responses from restoring
stale messages after a filter, sort, date, or focus change. Page cursors and
small page-coordinate metadata may remain outside the message window so
evicted pages can be revisited; full evicted `InboxMessage` payloads may not.

## Preserved Analysis pagination

The existing first, previous, next, and last page controls, range/total label,
and `messagesPage` URL state remain available and behave as Analysis controls,
not as Duty controls. Scrolling is an additional way to cross page boundaries;
it updates the visible page and URL as it does today. Trimming a distant page
does not reset the visible page, total count, or URL, and a page button can
still revisit that page.

Controls first align to a page already in the window. For an adjacent evicted
page they use the appropriate directional fetch. First/last jumps use their
existing boundary requests to replace the current window. Restoring an
arbitrary URL page may still require sequential cursor requests when the
server has no direct cursor for it, but intermediate responses must not
accumulate in the active message array. The range label describes the visible
logical page, including a partial final page, rather than using the bounded
window length as that page's item count. Button enablement reflects logical
page availability even when an adjacent page has been evicted; eviction alone
must not disable Next or Previous.

Direct-message navigation starts from a bounded context containing the
target, preserves target highlighting/alignment, and continues to page in
either physical direction after the target is released. Its page controls
retain the same logical page numbering and boundary behavior.

The existing `loadAllMessages` entry point must not issue a `nolimit` request
or store an unlimited result. Any remaining caller is routed to bounded
navigation; if the entry point has no production caller, it can be removed
along with its `nolimitShown` state. This is a deliberate change from its old
unbounded semantics, as requested.

## Scroll, refresh, and auxiliary state

The shared feed captures the first visible message and offset before a window
update and restores them after prepend, append, and opposite-edge eviction.
If an explicit page or link jump replaces the whole window, it lands on that
target instead. Skeletons remain in flow at whichever physical edge is loading
and do not count toward the 40-message limit. A failed load removes the edge
loading state, retains the current window and anchor, and uses the existing
Analysis error notification path.

Every ingress that replaces or merges feed messages (initial load, regular or
focused paging, direct-link context, refresh, realtime update, and edit) must
preserve the 40-message invariant. Realtime updates, message edits, and
refreshes update only messages still in the active window; evicted cards are
refreshed from the server when revisited.
Card-specific state keyed by message ID, such as loaded comments, should be
pruned with evicted payloads when it has no other active consumer. Shared
reference data (for example group and callsign catalogs), unread metadata,
and navigation cursors are not message cards and retain their existing
lifecycles. Filter or sort changes reset window boundaries and request
generation together so the old and new query cannot be mixed.

## Verification and scope

Add failing tests before implementation for repeated forward loads staying at
or below 40, backward re-fetch after eviction, both Analysis sort directions,
focused-link paging in both directions, page-control range/enablement and URL
restoration, stale/failed requests, and stable visible-message offset. Exercise
the same window operation through Duty tests so the refactor preserves its unread and
evicted-tail behavior. Browser regression tests should scroll through several
chunks on both pages and verify bounded rendered message count, edge
skeletons, and reading-anchor stability. Run the affected Vitest and
Playwright suites, `just test-fe`, and `just build-front`.

The work does not change card actions, search, Important lists, replies,
mentions, the backend pagination API, or the visual appearance of the feed.
It does not make the message-feed component own data loading. Completion means
both page owners use the shared window operation, Analysis never accumulates
unbounded message cards in any feed-navigation mode, and previously reachable
messages remain reachable through scrolling or explicit navigation.
