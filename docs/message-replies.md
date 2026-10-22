# Message replies

Issue: [#3612](https://github.com/echoua/echo/issues/3612).

Duty Neo and Analysis Neo expose `Відповісти` in the shared message actions. It
opens the standard New Message surface with one read-only citation. This release
does not expose a selector for additional citations. The submission API, database,
editor state, and renderer accept citation collections so future selection UI
does not require changing their relationship model. Reply bodies are independent
of cited bodies; originals are not copied into the new message automatically.

## Storage and deletion

`message_reply` joins a regular `signal_message` to each original. Both foreign
keys use `ON DELETE SET NULL`; relationships and surviving messages persist when
either endpoint is removed. `deleted` means either endpoint was deleted, rather
than that the relationship should be hidden. Deleted rows remain in `Ланцюжок`
and its count, and display a cancel icon followed by `Видалено` without fetching
the deleted citation body, timestamp, or link. Missing or inaccessible messages
are shown as unavailable, without assuming deletion.

Database triggers handle soft and physical deletion and enqueue invalidations.
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

## API and access

`POST /api/rer-importer/message-replies` accepts `signal_message_ids` (at most
512 per request) and `screen` (`Duty` or `Analysis`). It returns:

- `replies`: all direct relationships with either endpoint in the authorized
  requested set, including tombstones, ordered by `(created_at, id)`.
- `reply_messages`: deduplicated citation projections for available requested
  anchors and the available endpoints of live relationships. Each projection
  contains its ID, event timestamp, creation timestamp, preview, and relative
  screen-specific `?m=` link. Tombstones do not hydrate their missing counterpart.

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

`POST /api/1.1/submit-direct` accepts optional `cited_signal_message_ids` separately
from intelligence-report parents and copy sources. It validates citations and
saves the message and relationships atomically. A reply cannot be combined with
editing or report/copy creation. Deletion during composition causes validation
to fail without creating a partial message or losing the draft.

Destination selection prefers the clicked source group's authorized context.
For ambiguous membership it tries source groups in deterministic order, using
only an authorized common group for multiple citations. Group rejections are
logged and the next eligible source group is tried before message persistence.
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
new tab. Direct replies appear below originals under `Ланцюжок`, ordered oldest
to newest by relationship creation time and ID, with a count and numbered,
connected rows. Keyboard focus selects the row marker; deleted rows retain their
number and have no navigation action. Conversations are not expanded recursively.

Mounted cards register with a page-owned batched store; their first reply query
does not block base message rendering. Unmounted card snapshots remain in a
bounded cache for Duty viewport offload. Redis inbox events only invalidate reply
state. Duty refreshes after its existing polling coordinator admits a due count
cycle. Analysis refreshes when its reconciliation scheduler admits a batch and
also checks mounted cards on the existing 30-second system interval, recovering
missed events. Polling refreshes complete anchor snapshots, including empty ones.
Version guards reject responses invalidated in flight, and failures retry during
scheduled work. Saving a reply explicitly refreshes the displayed chain.

`message_reply_change` is a database outbox drained by the existing background
worker process. Source transactions commit before their invalidations become
visible. Failed Redis delivery retains the outbox rows for retry. The relationship
table uses the normal new-table analytics snapshot; source provenance and outbox
tables are PostgreSQL-only and are declared in the packaged exclusions. No full
mirror resync or manual historical reconciliation is required.

## Regression coverage

- `wdintel-rs/src/message_reply/tests.rs`: persistence, authorization boundaries,
  multi-citation atomicity, deletion survival, preview limits, source replay,
  and late original resolution.
- `wdintel-rs/src/message_reply/tests_api.rs`: viewer reply access with ordinary
  creation still forbidden.
- `wdintel-web/src/ts/react/routes/shared/message-replies/__tests__/reply-store.spec.ts`:
  event batching, stale deletion protection, failed-load recovery, and missed events.
- `wdintel-web/tests/e2e/message-replies.spec.ts`: both screens' citation/chain
  display, tombstones, confirmed navigation, and standard reply composition.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx`
  and `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`: existing scheduling,
  scrolling, and unread safeguards remain applicable to the shared card.
