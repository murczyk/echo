# Linked Message Navigation Design

**Status:** Proposed for written review

**Issue:** [#3689](https://github.com/echoua/echo/issues/3689)

**Base branch:** `main`

## Intent

Duty and Analysis must use the same permalink-navigation lifecycle without
combining their data models. Opening a copied message link should resolve an
accessible message, load its surrounding messages, and land on its card. The
shared mechanism must be reusable by future search results, Important lists,
replies, and mentions, but none of those result sources is implemented here.

This is a focused follow-up to the existing shared `MessageFeed` component. The
broader [navigation foundation proposal](2026-10-07-message-feed-navigation-foundation-design.md)
also describes return-to-origin sessions and future source-specific behavior;
those are not prerequisites for this incremental change. Current code and tests,
not that proposal's older implementation assumptions, govern this work.

## Current behavior and constraints

- The shared link builder copies `/rer-duty-neo?m=<reference>` from Duty and
  `/rer-analysis-neo?m=<reference>` from Analysis. A copied link does not contain
  filter state. Both routes accept `m`, `mid`, and `messageUid` on read.
- A cold Duty link without `state` creates one feed with `emptyFilter()` and
  does not overwrite the user's persisted Duty filters. Duty resolves the
  context, loads a bounded target-centered window, and lands through its feed
  handle. Its live polling, unread state, watch mode, and directional loading
  remain Duty-owned.
- Analysis starts from URL query state, not an automatically reapplied saved
  filter. It still needs a valid time range: the existing direct-link path
  moves its default range around the target when necessary, then requests a
  focused window. Its page counts, pagination, and sort direction remain
  Analysis-owned.
- Both routes already call the access-checked `inbox-item-context` API. An
  absent, deleted, or inaccessible target must remain indistinguishable to the
  user. Both routes already use the shared `MessageFeed` handle and shared
  highlighting helper, but parse the link and orchestrate resolution, loading,
  landing, and errors separately.
- `MessageFeed` displays supplied items and owns scroll geometry. It does not
  own URL parsing, authorization, API calls, filters, or pagination.

## Scope

Unify the permalink entry and navigation lifecycle: parse the target reference,
resolve its accessible context, ask the current page to materialize the
surrounding messages, wait until the target is mounted, then land and highlight
it. A newer request, unmount, or page-state invalidation must prevent stale
requests from changing the feed or viewport. The shared lifecycle reports a
small typed outcome so both pages present consistent privacy-safe errors.

Do not change copied URL shape, add a new backend endpoint, change filters,
change the number of Duty columns on normal visits, combine Duty and Analysis
pagination, or add a generic return-to-origin UI. A manually assembled URL that
also includes explicit page filter state keeps the page's existing filter
semantics; this change guarantees the filter-free behavior of links produced by
the card's copy action.

## Recommended boundary

Create a small `shared/message-navigation` module with three responsibilities:

1. URL helpers own parsing and removal/canonicalization of the `m` parameter
   and its read-only compatibility aliases. The existing shared link builder
   remains the sole writer of copied links.
2. An access resolver calls `fetchInboxItemContext` and returns either an
   accessible context, a privacy-safe `unavailable` result, or a request error.
   It does not infer a user's group permissions from client-side state.
3. A navigation coordinator owns operation identity, cancellation, the
   `resolving -> materializing -> landing -> focused` lifecycle, and outcome
   classification. It receives page operations through an adapter, rather
   than importing either page.

The adapter boundary is intentionally narrow:

```ts
interface MessageNavigationHost<Landing> {
  materialize(context: InboxItemContextRsp, signal: AbortSignal): Promise<Landing>;
  land(landing: Landing): Promise<boolean> | boolean;
  invalidateNavigation(): void;
}
```

`materialize` uses the host's existing data path and resolves only when it has
identified the target and requested its surrounding window. `land` completes
only after the target is mounted in the relevant `MessageFeed`; it delegates
scroll and focus to the shared feed handle and highlight helper. A host may
return `false` if the target cannot be mounted after loading. Concrete type
names and callback shapes may be refined during planning, but the ownership
boundary must stay the same. The coordinator must check its operation identity
after every awaited step, and adapters must also respect their own feed/query
generation guards. An `AbortSignal` cancels network work where supported;
operation checks cover React commits that cannot be aborted.

Duty's adapter selects the single cold-link feed, resolves its numeric target
IDs, pauses watch/follow, and invokes the current bounded initial-load and
`MessageFeed` landing path. Analysis's adapter adjusts the time range, loads
the focused window, preserves its current page/edge accounting, and lands
through the same feed-level target API. Neither adapter duplicates URL parsing,
access-result classification, or the common lifecycle.

## Results and user-visible behavior

- `focused`: the accessible target is mounted, centered, and highlighted.
- `unavailable`: the reference is absent, deleted, or inaccessible. Both pages
  show the same generic error without revealing which condition occurred.
- `load-error`: context or surrounding messages could not be loaded. Both
  pages show a retryable error through their existing snackbar provider; the
  current viewport remains usable.
- `landing-error`: the target was resolved but not present after materializing
  the window. Both pages show one consistent error; stale operations show none.

The coordinator returns structured outcomes; the shared message-navigation
module owns the notification text, while the page supplies its snackbar
function. It must not show a success notification for merely opening a link.
The existing link-copy success notification remains in the shared card helper.

On a copied link, Duty continues to open one unfiltered feed and preserves
stored filters for later visits. Analysis continues to start without saved
filter selections and may adjust its default date range to include the target.
Explicit user changes to a filter, time range, page, or feed during a pending
navigation cancel the old operation before its response can land. After
landing, ordinary scrolling and page controls retain their present behavior.

## Verification

Characterize both routes before replacing their orchestration. Tests must
cover canonical and legacy URL parameters, filter-free copied links, persisted
Duty filters remaining untouched, Analysis date adjustment, accessible and
unavailable targets, request errors, missing target after load, cancellation
at each asynchronous stage, and no stale scroll or duplicate snackbar.

Keep page-specific regression suites for Duty's bounded 40-card window,
polling/unread/four-feed behavior and Analysis's 20-message pages, reverse
ordering, and bidirectional focused loading. Add shared coordinator tests with
small fake adapters plus browser tests that copy and open one link on each
route, including an unavailable target. Run affected Vitest and Playwright
suites, `just test-fe`, and `just build-front`; report unrelated full-suite
failures without weakening assertions.

The change is complete when both permalink routes use one URL parser, one
access resolver, and one navigation lifecycle, while each page retains its own
materialization and the shared `MessageFeed` remains independent of routing
and APIs.
