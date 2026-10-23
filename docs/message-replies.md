# Message replies

Issue: [#3612](https://github.com/echoua/echo/issues/3612).

Duty Neo and Analysis Neo expose `Відповісти` in the shared message actions. It
opens the standard New Message surface with one read-only citation of the clicked
message. A reply starts a thread when the selected message is independent, or
appends to its existing thread. Replying to a reply always uses that thread's
original message as the head. Reply bodies are independent of cited bodies.
Only one message can be selected for a reply.

## Storage and deletion

`message_reply` joins a regular `signal_message` to its thread head. The nullable
`engaged_message_id` records the message actually selected for the reply, including
native messenger targets. A unique reply index prevents a message from belonging
to several threads. `thread_id` keeps surviving members together after physical
deletion of the head. All message foreign keys use `ON DELETE SET NULL`;
relationships and surviving messages persist when either endpoint is removed. `deleted` means either endpoint was deleted, rather
than that the relationship should be hidden. Deleted endpoints remain in `Ланцюжок`
and its count, and display a cancel icon followed by `Видалено` without fetching
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
editing or report/copy creation. Deletion during composition causes validation
to fail without creating a partial message or losing the draft.

Destination selection prefers the clicked source group's authorized context.
For ambiguous membership it tries the selected message's source groups in
deterministic order. Group rejections are logged and the next eligible source
group is tried before message persistence.
Other validation failures, authentication failures, network errors, timeouts,
and server errors stop submission. There is no automatic resubmission after a
possibly committed request. Exhaustion shows an error and preserves the draft.

## Rendering and refresh

Citations use the screen's time basis: creation time on Duty, and the saved
event/creation-time preference on Analysis. Both timestamps are returned so
switching the Analysis preference does not require another citation query.
Dates use the application timezone and `DD.MM · HH:mm`; an absent selected
timestamp uses `Час невідомий`. Duty ordering, filtering, unread cursors, and
notifications retain the [creation-time contract](duty/README.md#creation-time-contract).

Original citations appear below tags under `Оригінальне повідомлення`. The label
and timestamp prompt for confirmation before opening the appropriate screen in a
new tab. All other thread items appear below the original under `Ланцюжок`,
ordered oldest to newest by relationship creation time and ID, with a count and numbered,
connected rows. The current message is excluded from both sections; the head
appears only when viewing a reply. Keyboard focus selects the row marker; deleted
rows retain their number and have no navigation action. Cards use the flat thread
snapshot without recursive client requests.

Mounted cards register with a page-owned batched store; their first reply query
does not block base message rendering. Unmounted card snapshots remain in a
bounded cache for Duty viewport offload. Redis inbox events only invalidate reply
state. Duty refreshes after its existing polling coordinator admits a due count
cycle. Analysis refreshes when its reconciliation scheduler admits a batch and
also checks mounted cards on the existing 30-second system interval, recovering
missed events. Polling refreshes complete anchor snapshots, including empty ones.
Version guards reject responses invalidated in flight, and failures retry during
scheduled work. Saving a reply explicitly refreshes the displayed chain.
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
  display, tombstones, unavailable citations, confirmed navigation, desktop/mobile
  composition, viewer permissions, and timestamp preference changes without fetching.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx`
  and `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`: existing scheduling,
  scrolling, and unread safeguards remain applicable to the shared card.
