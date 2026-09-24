# SIGINT inbox Iggy events

The configured inbox topic carries the existing creation record as a JSON pair
`[sigint_inbox_item_id, inbox_message]`. The message includes the existing
`aor_ids`, `sigint_callsign_ids`, `sigint_unit_ids`, `sigint_signal_ids`, and
`sigint_network_freq_ids` enrichment fields. `activity_at_ms` is the
interception time used for network frequency matching.
Creations are also retained in the transactional outbox, preventing a
concurrent commit with an earlier creation timestamp from falling behind the
worker cursor. Restoring a deleted item emits the same creation form. Consumers
should treat repeated creation pairs as upserts.

Later changes are JSON objects with `event_id` and `event_type`. Item events
also contain `sigint_inbox_item_id`. A consumer should deduplicate by `event_id`:
the worker deletes an outbox row only after Iggy acknowledges it, so retries can
repeat an event. The worker reads committed rows in outbox ID order; concurrent
database transactions can commit in a different order.

Queued events retain the Iggy URL, inbox topic, credentials, and API user that
were active when they were captured. Unsent creation records use the connection
version active at their creation time. Changing an integration's settings does
not reroute its backlog; later records use the new settings. Historical inbox
items from before the integration began are not replayed to a new destination,
so consumers need a separate backfill before applying future deltas. Keep the
previous connection available until its backlog has drained.
Drained destinations keep their route and API-user history so a route cannot be
reused with a different user; obsolete Iggy login credentials are cleared.

| `event_type` suffix | Additional fields | Meaning |
| --- | --- | --- |
| `updated` | `message` | Replace the inbox message snapshot after item, message, importance, unit, tag, metadata, point token, media, derived media result, or group edits. |
| `deleted` | none | Remove an inbox item after deletion or loss of access to its last visible group. |
| `network_linked`, `network_unlinked` | `sigint_network_id`, `sigint_network_freq_ids`, `sigint_network_callsign_ids`, `sigint_callsign_ids` | Add or remove the network, its matching frequency IDs, active network callsign IDs, and their catalog callsign IDs. |
| `network_frequencies_changed` | `sigint_network_id`, `unlinked_sigint_network_freq_ids`, `linked_sigint_network_freq_ids` | Apply an inbox frequency or interception time edit. |
| `callsign_linked`, `callsign_unlinked` | `sigint_inbox_item_callsign_id`, `callsign`, `sigint_callsign_ids` | Apply an inbox callsign edit. |
| `settlement_linked`, `settlement_unlinked` | `settlement_id` | Apply a resolved settlement link change. |
| `aors_changed` | `aor_ids` | Replace the item's complete effective AOR ID list. |

Every suffix above is prefixed by `sigint_inbox_item_`. Network frequency IDs
match the inbox item's `freq` and interception time against the network's
frequency rows. The current inbox schema stores one `freq` value per item;
multiple matching network frequency rows are included. The worker publishes
item updates and associations only for inbox items visible to the integration's
API user. Deletion events carry only the item ID and are published after
physical deletion even when the item is no longer visible. For group visibility
loss, the event is sent only to integrations whose API user could access the
removed group.

Changes to group state, zone assignments, organisation group selection, and
secret-group membership reconcile every affected snapshot. Newly visible items
are replayed as creation upserts, while items that are no longer visible emit
deletion events.

An item's effective `aor_ids` are sorted and unique. When the item has at least
one network link, they are the union of the AORs assigned to every linked
network; a linked network set with no AOR assignments produces an empty list.
Without network links, they are the union of the AORs assigned to every message
group. Network-link, network-AOR, message-group, group-AOR, and applicable
datasource-group changes enqueue `sigint_inbox_item_aors_changed`. The event is
a current snapshot, so retries or several changes before publication can repeat
the same list.

All activity and frequency interval times use UTC.

Deleting a network emits frequency-unlink events for its retained frequency
rows; restoring it emits the corresponding link events.

Network catalog edits have no inbox item ID. A consumer applies them to its
items linked to `sigint_network_id`. The worker sends them only when the
integration's API user can see at least one currently linked inbox item:

| `event_type` | Additional fields | Meaning |
| --- | --- | --- |
| `sigint_network_callsign_linked`, `sigint_network_callsign_unlinked` | `sigint_network_id`, `sigint_network_callsign_id`, `sigint_callsign_id`, `sigint_callsign_ids`, `callsign` | Add or remove a network callsign association. The singular catalog ID may be null; the plural IDs are text matches. |
| `sigint_network_frequency_linked`, `sigint_network_frequency_unlinked` | `sigint_network_id`, `sigint_network_freq_id`, `freq`, `active_from`, `active_to` | Add or remove the frequency association for linked items with the same `freq` whose `activity_at_ms` is in the given inclusive interval. A null `active_to` has no upper bound. |

Catalog callsign and unit visibility changes refresh network callsign text
matches with an unlink/link pair.

## REST reference dictionaries

Authenticated users with the `Api` role can load the dictionaries referenced
by these events:

- `GET /api/1.1/settlements` returns every canonical settlement ordered by ID,
  including its kind, administrative names, coordinates, and tag.
- `GET /api/1.1/tags` returns every tag ordered by ID, including disabled tags
  and tags owned by any organisation. Each row includes its label, display
  metadata, flags, and optional owner organisation ID.

These routes are API-role-only and do not change the organism-scoped UI tag
routes.
