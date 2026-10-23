# Message replies

Issue: [#3612](https://github.com/echoua/echo/issues/3612).

Both Neo screens already have a working frontend for basic replies: a message
action, a source preview, a locked destination group, an independent body, closing
after successful submission, and reciprocal direct citations. Existing state and
polling also refresh edited previews and deleted citation markers in other
sessions. These pieces should be reused when completing the shared-thread flows.

## Implementation status against the group-thread plan

The implementation on `3612-reply` uses direct citation edges. The
[revised implementation plan](superpowers/plans/2026-10-22-group-message-replies.md)
keeps the agreed shared-thread scenarios and builds on the existing backend.
Its pending extensions are not current API contracts. Use the verified contracts
below and generated bindings for fixtures.

| Planned behavior | Current implementation |
| --- | --- |
| The same side drawer as ordinary Neo creation | Reply uses the shared page editor, responsive embedded/modal presentation, draft-intent guard, and source outline |
| Every member links to every other member | Only direct originals and replies are returned; no recursive expansion |
| Two compact links and a paged `Усі N` popover | Two direct relations on the card; additional direct relations in a scrolling popover. The API still returns all direct relations; no server pagination |
| Smooth navigation within the current feed | Clickable preview navigates within the source feed, loading a distant window if needed; filters remain unchanged |
| Save a reply after its original is deleted | Submission rejects an unavailable source and preserves the draft |
| Detach while composing or editing | No detach control or mutation API |
| Blue outline around the source while composing | Shared editor selection highlights the source in its own feed |
| Echo-only relationships | Echo composition plus native Signal/WhatsApp source reconciliation |
| Group-scoped thread identity and member order | No thread identity; direct edges ordered by relationship creation time and ID |

These differences do not establish that the original requirements were withdrawn.
Browser tests with mocked HTTP responses verify UI behavior; they do
not prove database atomicity, authorization, reconciliation, or performance on
large histories. Those require the backend tests and database plan measurements.
The endpoint limits requested anchors to 512; this is not a reply-list page size.
Direct relationships use endpoint indexes, but the response has no pagination or
independent cap on relationships per anchor. A large number of replies therefore
still increases response size and rendered rows; no production-scale performance
guarantee follows from the anchor limit alone.

### Acceptance scenarios remain unchanged

The 24 E1–E13 checks in `message-reply-threads.spec.ts` and
`message-replies-multi-user.spec.ts` preserve the agreed user journeys, including
all-member navigation, paged overlays, detach, and successful creation after source
deletion. Their fixtures use the existing wire contract where it exists; missing
behavior must remain a meaningful failing assertion, not be redefined as success.

The [revised implementation plan](superpowers/plans/2026-10-22-group-message-replies.md)
records every scenario and separates existing code from required changes. It also
identifies the thread/page/detach contracts that must be specified before feature
implementation. Current native citations are not automatically Echo thread members.

Mocked E2E responses do not demonstrate that the current backend supports a full
thread or a successful deleted-source submission. There is no successful detach
fixture contract yet; it must be added alongside the real backend contract, without
changing the accepted detach scenarios. The existing direct-citation regression
suite continues to document behavior already implemented in this branch.

Duty Neo and Analysis Neo expose `Відповісти` in the shared message actions. It
opens the page's standard `ManageMessageDrawer` with one read-only citation. Desktop
uses the embedded side editor and mobile uses its standard modal presentation.
Opening another editor intent uses the same unsaved-draft guard. This release
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
Ungrouped ownership follows the preferred sender before `login_id`; inherited
read access uses direct report/comment parents, matching the inbox read endpoint.

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

Direct relationships appear under `Ланцюжок`, below intelligence-report links.
Each numbered item has the selected timestamp and one truncated preview line;
the whole available item is a link. At most two items render on the card.
For larger lists, `Усі N` opens a lazily mounted anchored popover with its own
bounded, contained scroll. Opening it does not increase the card height.
`N` counts the direct related messages, excluding the current card; this is not
a total for a transitive shared thread. Deleted rows retain their number and
have no navigation action. Conversations are not expanded recursively.

Clicking a preview closes the popover and resolves the target through existing
message-navigation APIs in the same tab. Duty targets the originating column;
Analysis loads a focused window without expanding the date range. Filtered-out
targets show a notification asking the user to change filters; unavailable targets
and API errors also produce visible notifications. Existing loaded Duty targets
use the feed's scrolling API with the reduced-motion preference; newly loaded
windows use its focus mechanism to hold the target through layout reconciliation.
Duty reply landings stay within the loaded content: the newest reply appears at
the bottom of the list without artificial space below it, including after a jump
from a different history window.
The frontend does not add new API endpoints or implement server pagination.

Browser coverage for these frontend behaviors:
`wdintel-web/tests/e2e/message-replies-frontend.spec.ts` and
`wdintel-web/tests/e2e/message-replies.spec.ts`. The unchanged full E1–E13 suite
continues to describe backend-dependent shared-thread behavior. Detach, including
removing the source while composing, is deferred to a separate iteration.

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
  multi-citation atomicity, deletion survival, preview limits, source replay,
  late original resolution, split processing, and concurrent canonical remapping.
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
- `wdintel-web/tests/e2e/message-reply-threads.spec.ts`: the unchanged E1/E2/E4/E6/E7/E12
  acceptance scenarios on both Neo screens, using existing citation requests where
  supported. Unimplemented thread and detach behavior remains red.
- `wdintel-web/tests/e2e/message-replies-multi-user.spec.ts`: the unchanged E3/E5/E8–E11/E13
  acceptance scenarios, including multi-user chains, deletion, detach, and their
  races. Deletion during composition is required to permit saving. HTTP responses are
  scripted with generated types; transactions and native reconciliation are not
  reimplemented in these fixtures.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx`
  and `wdintel-web/tests/e2e/rer-duty-scroll-stability.spec.ts`: existing scheduling,
  scrolling, and unread safeguards remain applicable to the shared card.
