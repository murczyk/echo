# Message replies

Issue: [#3612](https://github.com/echoua/echo/issues/3612).

Duty Neo and Analysis Neo expose `Відповісти` in the shared message actions. It
opens the page’s shared responsive editor with a read-only citation of the clicked
message, a locked source group, an independent empty body, and a blue source outline.
The editor closes after successful creation and uses the existing unsaved-draft guard. A reply starts a thread when the selected message is independent, or
appends to its existing thread. Replying to a reply always uses that thread's
original message as the head. Reply bodies are independent of cited bodies.
Only one message can be selected for a reply. The citation spans the editor grid
as a separate row above the regular content and metadata columns; narrow editors
keep the same single-column reading order.

## Storage and deletion

`message_reply` joins a regular `signal_message` to its thread head. The nullable
`engaged_message_id` records the message actually selected for the reply, including
native messenger targets. A unique reply index prevents a message from belonging
to several threads. `thread_id` keeps surviving members together after physical
deletion of the head. All message foreign keys use `ON DELETE SET NULL`;
relationships and surviving messages persist when either endpoint is removed. `deleted` means either endpoint was deleted, rather
than that the relationship should be hidden. Deleted endpoints remain in `Ланцюжок`
and its count, and display a neutral bubble labeled `Повідомлення видалено` without fetching
the deleted citation body, timestamp, or link. Endpoint deletion flags are returned
separately so deleting a head does not hide surviving replies. Missing or
inaccessible messages are shown as unavailable, without assuming deletion.

Database triggers resolve heads, reparent descendants when an ancestor arrives or
is remapped, handle soft and physical deletion, and enqueue invalidations.
Descendants are updated as a set so a long chain does not exhaust the trigger stack.
Invalidations include a surviving member when the head has been physically deleted. Reply
mutations acquire one transaction advisory lock before source and relationship
locks so concurrent native reconciliation cannot create divergent heads. When
native sources share one canonical reply, its latest resolved target determines
its single thread; the source receipts retain their individual native targets.
The migration preserves the earliest existing relationship when old multi-citation
rows share a reply. Nullable column backfill publishes the additive analytics
schema through CDC; empty tables use the existing targeted snapshot fallback.
The soft-deletion flag is reconciled when a message is restored, including the
temporary staging cycle used by messenger edits; a temporary stage must not turn
an active citation into a permanent deletion warning. A null endpoint resulting
from physical deletion retains its deletion marker.
Private per-endpoint markers distinguish an unresolved original from an endpoint
that was physically deleted, even while the surviving message is edited.

`message_reply_source` persists source receipts and canonical message mappings
before queue snapshots are acknowledged. It survives queue consumption and Echo
IM retention, supports idempotent processing, and resolves originals that arrive
after their replies. This provenance is internal and is not returned to clients.
Signal and WhatsApp use Echo IM's inbox/outbox receipt identity, never a body or
timestamp guess. Receipt parsing follows the pinned Echo IM `inbox-id:` and
`instance:id:` formats; its receipt helper module is private. Outbox-only targets
without an Echo signal message remain unavailable. Existing history is not
backfilled automatically.
When inbox processing splits a native message into several visible messages,
its citation identity uses the active result with the smallest signal-message
ID. Provenance is bound after processing so it never points at the deleted
oversized container when an active result exists. Duplicate promotion updates
every surviving source mapping. If both native endpoints deduplicate to one
canonical message, retain an unavailable original until their identities separate;
never create a self-reference.

## API and access

`POST /api/rer-importer/message-replies` accepts `signal_message_ids` (at most
512 per request) and `screen` (`Duty` or `Analysis`). It returns:

- `replies`: all relationships in the threads of authorized requested messages,
  including tombstones, ordered by `(created_at, id)`. Each includes its stable
  thread key and separate head/reply deletion flags.
- `reply_messages`: deduplicated citation projections for available requested
  anchors and the available endpoints of thread relationships. Each projection
  contains its ID, event timestamp, creation timestamp, preview, and relative
  screen-specific `?m=` link. Deleted endpoints are never hydrated; surviving
  thread items remain available.

The preview is the first two newline-delimited lines, capped at 256 Unicode
characters after CRLF normalization, and is truncated in PostgreSQL. Empty body
previews use `Без тексту`. Adding sender login, attachments, or other citation
information requires extending this endpoint, the Rust contract, and generated
bindings. Rendering citations must not fall back to fetching full inbox messages.

The server checks source and counterpart visibility independently using existing
group, datasource, ownership, and intelligence-parent access rules. Deleted and
inaccessible bodies and usable links are not returned. Authenticated readers,
including viewer roles, can reply to readable sources. Normal creation/editing
and privileged unit/device/report operations retain their existing authorization.
Ungrouped ownership follows the preferred sender before `login_id`; inherited
read access uses direct report/comment parents, matching the inbox read endpoint.

`POST /api/1.1/submit-direct` accepts one optional `engaged_message_id` separately
from intelligence-report parents and copy sources. It validates the selected
message and saves the message and relationships atomically. A reply cannot be combined with
editing or report/copy creation. If a successful citation refresh shows that the
selected source is no longer available while composing, the editor explains that
it will save an independent message. The submit omits `engaged_message_id` while
preserving the draft, attachments and locked group. Source availability is read
again when building the payload after uploads; no additional history query is
needed. Missing projection data is described as unavailable, not proof of deletion.
A deleted-source validation failure before the refresh still leaves the draft
open: the current server exposes it as a generic 500, so the frontend cannot
safely retry automatically as an independent message.

Destination selection prefers the clicked source group's authorized context.
For ambiguous membership it tries the selected message's source groups in
deterministic order. Group rejections are logged and the next eligible source
group is tried before message persistence.
Other validation failures, authentication failures, network errors, timeouts,
and server errors stop submission. There is no automatic resubmission after a
possibly committed request. Errors preserve the draft and reply target. The
existing synchronous in-flight guard and disabled submit button prevent repeated
clicks or form submissions from sending a second request during a save. This is
not protection against retries after an unknown commit or across browser tabs.

## Rendering and refresh

Citations use the screen's time basis: creation time on Duty, and the saved
event/creation-time preference on Analysis. Both timestamps are returned so
switching the Analysis preference does not require another citation query.
Dates use the application timezone and `DD.MM.YYYY · HH:mm`; an absent selected
timestamp uses `Час невідомий`. Duty ordering, filtering, unread cursors, and
notifications retain the [creation-time contract](duty/README.md#creation-time-contract).

The editor records input before notifying the parser. Deferred parser effects read
the current form values so an older empty render cannot clear a newer draft.

Available thread items are ordered by `(CitedMessage.createdAt, CitedMessage.id)`:
message creation in Echo, regardless of relation creation, interception time or
the Analysis time-basis setting. This includes late-arriving native originals;
the head label does not pin them ahead of earlier-created messages. Compact
previews and the popup share the same order. The current API omits creation
metadata for deleted/unavailable endpoints, so those placeholders retain their
response slots while available entries are sorted around them. Exact creation
ordering for placeholders after a reload needs backend metadata and is outside
this frontend-only change.

Thread items appear below intelligence-report links under the `Ланцюжок` label,
using the same color and opacity as the card creation time. Compact clickable
previews show only one truncated text line, without dates or a head label. The
popup uses a primary-text heading, dates and times on available items, and a
vertical stepper with small solid dots in the same color as its connecting lines.
The popup includes the current card; only compact previews exclude it. The count
includes every thread member. Deleted endpoints retain their place without
exposing content or a navigation action. Their neutral bubbles show the gray text
`Повідомлення видалено`, without an icon. Separate head/reply deletion flags keep surviving replies
visible after deletion of the head.

The card shows up to two latest other thread members, keeping their creation-time
order. Threads with more than two members
offer `Усі повідомлення N`, with the count badge only on that button. It opens a lazily mounted anchored popover with
its own bounded scroll; the card height does not grow. The backend currently
returns the entire thread in one response, so this is not server pagination.

Clicking a preview navigates in the current feed and tab through existing message
navigation APIs. Reply landings ease out over 300 ms, remain interruptible by
reader scrolling or a newer navigation, and skip spatial motion when reduced
motion is enabled. Distant targets still load only a bounded window. The navigation outline fades and clears after two seconds; the
editor source outline remains active while composing. Duty uses the originating column and constrains reply landings
to loaded content, avoiding empty space under the newest reply. Analysis uses its
focused window without expanding the date range. Targets outside the current
filters show `Поза поточними фільтрами` before clicking. The page batches
candidate-only checks through the existing matching-filters API (100 IDs per
request, a bounded cache per feed), shares checks between cards, and invalidates
results when filters or messages change. Returned full-message data is used only
for membership checks, never as a citation-content fallback. Filtered-out targets produce a
notification asking the user to change filters; filters are not changed implicitly.

The current E1–E10 scenarios remain in
`wdintel-web/tests/e2e/message-reply-threads.spec.ts` and
`wdintel-web/tests/e2e/message-replies-multi-user.spec.ts`.
`wdintel-web/tests/e2e/message-replies-frontend.spec.ts` covers the current editor,
popover, source-feed navigation, and newest-reply landing. Their fixtures must use
the current single `engaged_message_id` contract and thread/deletion fields.
Pagination is excluded from this iteration: the popup renders the returned thread
inside its own scrolling viewport. Native Signal/WhatsApp relationships belong
to the same model. Exact-group fallback restrictions and request-level create
idempotency remain backend limitations. Detach in create/edit and its race scenarios
are excluded from this iteration and its tests.
Mocked browser scenarios do not establish database concurrency or performance on
large histories; those need real database tests and query-plan measurements.

Mounted cards register with a page-owned batched store; their first reply query
does not block base message rendering. Unmounted card snapshots remain in a
bounded cache for Duty viewport offload. Redis inbox events only invalidate reply
state. Duty refreshes after its existing polling coordinator admits a due count
cycle. Analysis refreshes when its reconciliation scheduler admits a batch and
also checks mounted cards on the existing 30-second system interval, recovering
missed events. Polling refreshes complete anchor snapshots, including empty ones.
Version guards reject responses invalidated in flight, and failures retry during
scheduled work. Saving a reply explicitly refreshes the displayed chain.
An invalidated first hydration retries only the still-unloaded anchors immediately,
so a newly created card does not wait for the next scheduled polling cycle.
If a request is already running, the explicit refresh follows it and rejects its
older snapshot. An unavailable editor citation ends its loading state while
preserving the draft.

`message_reply_change` is a database outbox drained by the existing background
worker process. Source transactions commit before their invalidations become
visible. Failed Redis delivery retains the outbox rows for retry. The relationship
table uses the normal new-table analytics snapshot; source provenance and outbox
tables are PostgreSQL-only and are declared in the packaged exclusions. No full
mirror resync or manual historical reconciliation is required.

## Regression coverage

- `wdintel-rs/src/message_reply/tests.rs`: persistence, authorization boundaries,
  single-target submission atomicity, deletion survival, preview limits, source
  replay, late ancestor resolution, long-thread reparenting, flat thread hydration,
  engaged-target preservation, split processing, and concurrent canonical remapping.
- `wdintel-rs/src/messenger/reconcile.rs`: duplicate promotion preserves reply
  links for surviving native sources and tombstones for deleted sources.
- `wdintel-rs/src/message_reply/tests_api.rs`: viewer reply access with ordinary
  creation still forbidden.
- `wdintel-web/src/ts/react/routes/shared/message-replies/__tests__/reply-store.spec.ts`:
  event batching, stale deletion protection, saved-reply refresh, preview edits,
  failed-load recovery, and missed events.
- `wdintel-web/tests/e2e/message-replies.spec.ts`: both screens' citation/chain
  display, tombstones, unavailable citations, in-feed navigation, desktop/mobile
  composition, viewer permissions, and timestamp preference changes without fetching.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx`
  and `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`: existing scheduling,
  scrolling, and unread safeguards remain applicable to the shared card.
