# Inbox Iggy events

## Retention

The [Iggy storage-policy job](../echo-iggy/STORAGE_POLICY.md) targets 100 GB of
actual allocated disk space across all topics and a maximum message age of
30 days. It deletes oldest sealed segments through Iggy's API, protects active
segments and consumer backlog, and verifies topic retention on every run.
Keep the native Iggy cleaner disabled when using this job; its logical
per-topic size limit cannot express the global physical disk budget.

Echo also explicitly configures inbox and analytics topics with 30-day message
expiry. Creating an API integration or changing its Iggy connection settings
reconciles its topics, preserving their other settings. Saving an existing
integration without changing those settings does not reconcile retention.
The storage-policy timer independently detects and repairs expiry drift.

After approval naming the affected Echo and Iggy hosts, this command can
reconcile current integration destinations, including disabled integrations:

```sh
wdintel-rs --mode=live oneoff-ensure-api-integration-iggy-topics --topics-only
```

It creates missing streams/topics and updates existing topics. `--topics-only`
leaves user permissions unchanged; omitting it grants non-root Iggy users
read/send access to the configured streams. Historical destinations and topics
no longer registered by an integration are outside the command's scope, but
are included by the local storage-policy job. The command stops at the first
error, retaining changes already applied. Serialize it with other topic edits
and the storage-policy job, and verify explicit
`message_expiry = 2592000000000` microseconds afterward.

Inventory current and historical destinations before running the command;
integration URLs may name other Iggy hosts, which must be included in the
approval. Keep old destinations available until queued events have drained.
Use an Echo binary containing explicit retention reconciliation, and confirm
each integration's credentials can read, create, and update its streams/topics;
`--topics-only` does not grant these rights. With both native and storage-policy
cleanup stopped under approval, reconcile and verify both inbox and analytics
topics, preserving names, partition counts, compression, replication, size
limits, and user permissions. Keep cleanup stopped until every intended topic
passes verification. On failure, inspect changes already applied and obtain
approval for recovery beyond the original scope. Repeating the command is
idempotent, but does not resolve stale consumers or authorize offset changes.

See the [rollout and verification procedure](../echo-iggy/STORAGE_POLICY.md#approved-rollout)
before installing or enabling cleanup. These changes require approval for
each target. Expiry uses Iggy's message timestamps rather than interception
timestamps in event payloads. Active segments and lagging consumers can block
cleanup; the maintenance service reports an error instead of silently claiming
that the limits were met. Deleted data cannot be recovered by disabling the
job or rolling back code.

## Event format

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

Settlement link changes are captured explicitly by the Rust settlement writers
in the same transaction as each change, including manual recalculation. AOR
configuration changes preserve existing settlement links. Direct SQL writes to
settlement links do not emit these events; see
[settlement recalculation](../wdintel-rs/src/battle_line/README.md).

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

## Unit visibility refresh queue

Unit creation, activation, deactivation, deletion, merge, and import enqueue
`api_integration_iggy_unit_refresh` rows in the same transaction as the unit
write. The unit visibility trigger is removed; interactive requests no longer
scan message history or expand these changes into the Iggy event outbox.
Comment-only and hierarchy-only edits do not need a visibility refresh unless
they also change a parent unit's activity. Direct SQL changes to unit visibility
must explicitly enqueue the refresh in the same transaction; use the application
writers for routine changes.

The background process owns `iggy_unit_refresh_worker`, a separate worker from
the Iggy publisher. It expands each job into the existing transactional event
outbox in pages of 500 rows. The stages traverse direct unit links, inbox
callsign matches, and network callsign matches. Each stage uses an indexed
cursor rather than an offset or a union of the unit's entire history. Repeated
matches can produce repeated snapshot events, which consumers already handle
as upserts. The publisher continues applying API-user visibility checks.

Each job retains its integration and destination. Old destination credentials
remain available while either refresh jobs or outbox events reference them.
Progress and generated events commit together. A failed batch rolls back both,
records its error, and becomes eligible again after 30 seconds; successful
batches reset the error. Row locks with `SKIP LOCKED` allow multiple background
processes without expanding the same batch concurrently. Refresh jobs do not
lock unit rows. New unit changes append separate jobs and do not wait for an
existing refresh job to finish.

The queue's `(next_attempt_at, id)` index serves ready-job selection and retry
scheduling. Separate integration and destination indexes support integration
deletion and credential retention. Historical reads reuse the unit-link,
catalog callsign, inbox callsign match-key, and network callsign match-key
indexes; see [query plan evidence](query-plans/3858-unit-refresh.md).

Inspect progress without modifying it:

```sql
select id, api_integration_id, destination_id, sigint_unit_id, created_at,
    stage, catalog_cursor, after_id, after_network_id, next_attempt_at,
    attempts, last_error
from api_integration_iggy_unit_refresh
order by next_attempt_at, id
limit 50;
```

Stages 0, 1, and 2 represent direct links, inbox callsigns, and network callsigns.
Resolve persistent errors before retrying; deleting a job discards required
refreshes. Restarting the background process resumes committed cursors.
Deployment must apply the new migration and the matching API/background binaries
together, with old writers stopped during the change. Include the excluded
queue table in the packaged analytics exclusions before migrating. No history
backfill or outbox deletion is needed. Rollback requires draining the queue
first; the migration refuses to discard pending jobs. Deployment, retry changes,
and rollback on a real environment require explicit approval.
Existing outbox events are preserved, so publication can still be delayed by
an existing Iggy backlog after unit saves become fast.

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
