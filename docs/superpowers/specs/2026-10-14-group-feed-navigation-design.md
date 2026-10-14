# Group Feed Navigation Design

**Status:** Approved

**Issue:** [#3727](https://github.com/echoua/echo/issues/3727)

**Base branch:** `main`

**Integration dependency:** `3689-scroll-feed-refactoring`

## Context

Duty (`Оперативний`) and Analysis (`Аналіз`) currently present aggregate
message feeds. A user can restrict an aggregate feed to one or more accessible
signal groups through the existing filters, but cannot navigate between groups
as conversations in a messenger.

The new navigation adds a group list and a dedicated group scope without
removing or weakening the aggregate feed. Duty may show up to four independent
feed columns, so every column needs its own group scope, group list, filters,
scroll state, and create-message action. Analysis has one feed and an existing
collapsible left panel.

The unmerged `3689-scroll-feed-refactoring` branch moves message loading,
windowing, anchors, and navigation for both routes into shared feed modules.
This feature must be implemented on top of those changes instead of adding a
second scroll or anchor implementation.

## Goals

1. Preserve the current aggregate feed and all current filtering behavior under
   the `Всі групи` scope.
2. Let a user select one accessible group and see only that group's messages.
3. Give every Duty column a fully independent group scope and filter state.
4. Reuse group navigation, unread state, UI primitives, and request-building
   logic between Duty and Analysis.
5. Provide durable, shared per-user unread state without per-group polling or
   N+1 requests.
6. Open a group at its oldest unread message and handle both Analysis list
   orientations.
7. Preserve current feed performance and avoid backend load while group lists
   are closed.
8. Lock the cross-route behavior with backend, frontend, and E2E tests.

## Non-goals

- Group avatar images. An avatar is text on a background only.
- Adding group colors to the group contract in this change. A neutral avatar
  background is used until a product-owned group color exists.
- Replacing current message filters, current aggregate unread logic, or feed
  pagination.
- Keeping Duty group lists permanently visible on desktop.
- Treating a filtered group view as proof that all messages in that group were
  read.
- Reimplementing feed windowing or scroll restoration outside the shared feed
  introduced by `3689-scroll-feed-refactoring`.

## Product model

Group navigation and filtering are separate concepts:

- `groupScope = all` displays the current aggregate feed. Its selected-groups
  filter and all other filters work exactly as they do now.
- `groupScope = <master_key>` hard-restricts the effective request to that
  group. The group selector inside the filter UI is hidden, while all other
  active filters remain in effect.
- Switching back to `all` restores the aggregate selected-groups filter without
  mutating it.

This separation prevents navigation from destroying a user's current filter
setup. It also permits two Duty columns to show two dedicated groups while a
third column shows an aggregate feed containing a custom subset of groups.

## Group ordering and presentation

`Всі групи` is always the first item. Remaining groups follow messenger
ordering: most recent feed activity first, with a stable name and master-key
fallback for equal activity.

A regular group avatar contains the first visible Unicode grapheme of the
trimmed group name on a colored circular background. There is no image avatar.
Because `SignalGroupEntry` currently has no color, all regular groups use the
neutral design token. The implementation must not invent a persisted color
contract. The `Всі групи` item may use its dedicated all-groups mark from the
approved mockup.

Unread badges are shown on every list item. Values greater than 99 render as
`99+`. Selection is conveyed by structure and styling, not color alone.

## Group island

Both routes show a pill-shaped group island matching the approved reference:
a circular avatar followed by the current group name on a dark rounded
surface. The island is a button with a visible keyboard focus state, accessible
name, and selected-group text that truncates safely.

In Duty, every feed column owns one island. Activating it opens that column's
temporary group panel over the feed. Selecting a group closes the panel and
changes only that column.

In Analysis, the island remains visible above the feed even while the left
panel is closed. Activating it opens the left panel directly to the group list.
The group list is part of the left panel and closes with that panel.

## Responsive behavior

On desktop Duty, the group panel overlays its owning column and does not reserve
permanent horizontal space. The other columns remain visible and keep their
state.

On desktop Analysis, the group list is permanently visible inside the open left
panel. Closing the panel removes the list from view but leaves the group island
available above the feed.

On mobile, both routes render the group list as a modal drawer over the active
feed. Opening and closing the drawer preserves the underlying feed position.
The drawer supports backdrop click, Escape, browser back where applicable, and
focus restoration to the island.

## Duty column independence

Each Duty column is an equal feed and owns:

- its group scope;
- its aggregate filter state;
- its group-panel open state;
- its feed request generation and abort lifecycle;
- its message anchor and scroll state;
- its create-message action.

Changing a group resets and anchors only that column. It must not reload,
re-sort, or alter any peer column.

Every column has a create-message FAB. On a fine-pointer desktop it appears on
column hover and keyboard focus-within. On touch/coarse-pointer layouts it
remains visible. In a dedicated group scope, opening the existing message
drawer supplies that group's `master_key` as the initial group. Under `Всі
групи`, the current recent/default-group behavior remains unchanged.

## Analysis behavior

Analysis stores the selected group scope in its URL state so reload, sharing,
and browser navigation preserve it. The existing filter state remains
independent.

The left panel contains the messenger-ordered group list and the existing
filter entry point. A dedicated group hides only the group-selection control in
the filters. Closing the panel closes both the list and filter UI. The island
reopens the panel at the group list.

## Unread semantics

Unread state is durable and shared by user and group across Duty, Analysis,
columns, tabs, and devices.

Opening a group with unread messages anchors the feed at the oldest unread
message by chronological feed order. `Oldest unread` is semantic and does not
mean top or bottom: changing Analysis orientation only changes the physical
direction in which the user moves toward newer messages.

A group read cursor advances only when all of these are true:

1. the feed is scoped to exactly one group;
2. no content-restricting filter is active;
3. the feed has reached the actual chronologically newest message for that
   group;
4. the request generation that established the tail is still current.

Presentation-only options do not block acknowledgement. Any filter that can
hide messages does block it. A filtered group view may position at the first
matching unread message, but it never marks the group read.

For a user/group pair without a stored cursor, the server atomically initializes
the cursor at the group's current tail. Existing history therefore starts read;
only later messages become unread.

The `Всі групи` badge retains the current feed-specific behavior. It reflects
the effective filters of that Duty column or Analysis feed and may therefore
differ between columns. It is not the sum of group badges. Counts remain unique
per message; the current data model is expected to associate a feed message
with one effective group, but queries must not rely on summing rows if that
invariant changes.

## Backend state and API

A new table stores the durable boundary for `(login_id, group_master_key)`.
The boundary uses the canonical monotonic message cursor used by the shared
feed, plus timestamps needed for diagnostics and safe idempotent updates. Its
foreign keys and indexes support:

- one row lookup/upsert per user and group;
- batch lookup of all rows for a user;
- monotonic `max(current, submitted)` updates that cannot move backwards.

A single group-feed-state endpoint returns every currently accessible group:

```text
masterKey
name
unreadCount
oldestUnreadMessageRef
lastActivityAt
```

It initializes missing read-state rows and calculates all group counts in one
set-based query. It uses the existing
`signal_message_group (group_master_key, signal_message_id)` index. Query plans
must be checked against realistic data before adding another index.

A separate idempotent acknowledgement endpoint accepts a group and the
validated current-tail cursor. It verifies group access and advances the stored
cursor monotonically. The response returns the resulting group state so the
client does not need an immediate follow-up request.

The oldest unread reference is compatible with the shared feed's around-message
navigation. All request and response types originate in Rust and are generated
for the frontend; backend types and codecs are not written manually in Elm.

## Client data flow and performance

Group feed state has one shared client cache used by both routes. The cache
provides a short TTL, in-flight single-flight deduplication, stale-result
rejection, and abort support. Multiple open Duty lists may share one batch
request, but every list renders its owning column's `Всі групи` count.

The existing `echo-inbox-changed` event invalidates the cache. Bursts are
coalesced before one batch refresh. There is no per-group request and no
one-second polling.

Refresh rules are visibility-aware:

- Duty fetches while at least one group panel is open. A closed panel only
  records that cached state is stale.
- Analysis fetches while its left panel is open. Closing the panel stops group
  state refreshes.
- Opening a panel, returning the document to visibility, or regaining focus
  revalidates stale data.
- Existing aggregate-feed counting continues independently.

Group-list failures retain the latest successful snapshot and show the standard
error toast. They do not block or clear the message feed.

## Frontend boundaries

The reusable UI follows a dumb-component boundary:

- `GroupAvatar`, `GroupIsland`, `GroupList`, `GroupListItem`, and the badge take
  data and callbacks only. They do not fetch, inspect route state, or build
  message requests.
- A shared group-navigation controller owns batch data, caching, event
  invalidation, sorting, selection helpers, and acknowledgement.
- Shared pure functions derive the effective feed request, classify
  content-restricting filters, and map unread anchors independently of visual
  orientation.
- Thin Duty and Analysis adapters own only route-specific layout, persisted
  state, URL integration, and panel mechanics.

The existing create-message drawer receives an optional
`initialGroupMasterKey`. It validates that group against the accessible catalog
before applying it and preserves current default behavior when the value is
absent.

## Integration with `3689-scroll-feed-refactoring`

Before feature implementation, merge `3689-scroll-feed-refactoring` into
`3727-groups-list`. Resolve conflicts by keeping the shared message-feed and
message-navigation abstractions from 3689.

Group changes must use the refactored request-generation lifecycle:

1. abort requests for the previous scope;
2. increment the feed generation;
3. clear stale pages and pending tail state for the affected feed only;
4. load around the unread reference, or use the normal current-feed entry point
   when no unread reference exists;
5. restore the correct physical anchor for the selected orientation.

No compatibility layer should preserve the superseded Duty or Analysis scroll
implementation.

## Loading, empty, and access-change states

- Loading belongs inside the group panel and never replaces the feed.
- `Всі групи` remains available when there are no accessible regular groups.
- An empty state explains that no groups are available.
- A group rename updates its label without losing selection because selection
  uses `master_key`.
- If access to the selected group is revoked, the affected feed falls back to
  `Всі групи` and shows a toast.
- Message deletion can reduce a count but cannot move a read cursor backward.
- New activity may reorder group rows; current selection remains stable.

## Accessibility

Islands and list rows use native button/list semantics, keyboard navigation,
visible focus, and at least the project's standard touch target. Selected state
and unread state have text/ARIA equivalents. Drawers trap focus while modal,
close predictably, and restore focus. Motion respects reduced-motion settings,
and no essential state is conveyed only through avatar or badge color.

## Verification

### Backend

- Access control excludes inaccessible groups and rejects acknowledgement for
  them.
- First use initializes at the current tail without reporting historical
  unread messages.
- Batch counts, oldest-unread references, and messenger ordering are correct.
- Concurrent initialization and acknowledgement are idempotent and monotonic.
- Deletes and group access changes produce correct state.
- The batch query is checked with `EXPLAIN` against realistic cardinality.

### Frontend unit and integration

- Group scope overrides request groups without mutating aggregate filters.
- Returning to `Всі групи` restores the previous selected-groups filter.
- Content filters prevent cursor acknowledgement.
- Orientation mapping keeps the same semantic oldest-unread anchor.
- Shared cache coalesces events and requests and rejects stale responses.
- Group selection resets only the owning Duty column.
- Dumb components render selection, badges, truncation, keyboard, loading, and
  empty states.

### E2E

Required Playwright coverage records the product contract:

1. Open two different groups in two Duty columns and verify independent feeds,
   filters, scrolling, and group panels.
2. Configure an aggregate Duty column for two groups, visit a dedicated group,
   return to `Всі групи`, and verify the original group filter is restored.
3. Open the create drawer from multiple Duty columns and verify each dedicated
   group is preselected; verify current default behavior for `Всі групи`.
4. Open a group at the oldest unread message in both Analysis orientations.
5. Verify a filtered group view does not clear unread, while reaching the live
   tail in an unfiltered view clears it in both routes.
6. Close the Analysis panel, keep the island visible, and reopen the panel from
   the island with selection intact.
7. Verify mobile drawers overlay the feed and preserve its position.
8. Count network calls to prove no per-group N+1 requests and no group-state
   refresh while all relevant panels are closed.
9. Revoke selected-group access and verify fallback and error feedback.

Affected browser suites must be run before merge in addition to focused unit
tests, `just test-fe`, `just build-front`, backend checks, formatting, and the
catalog-aware migration validation required by the repository.
