# Inbox Iggy events

## Retention

Echo explicitly configures inbox and analytics topics with 30-day message
expiry. Creating an API integration or changing its Iggy connection settings
reconciles its topics, preserving their other settings. Saving an existing
integration without changing those settings does not reconcile retention.

Run the updated Echo binary with:

```sh
wdintel-rs --mode=live oneoff-ensure-api-integration-iggy-topics --topics-only
```

The command processes the current inbox and analytics destinations of every
integration with an Iggy connection, including disabled integrations. It creates
missing streams/topics and updates existing topics. `--topics-only` leaves Iggy
user permissions unchanged. Without this flag, the command also grants every
non-root Iggy user read/send access to the configured streams.
Historical destinations retained for queued events and topics no longer
registered by an integration are outside this command's scope; inventory them
separately and keep old destinations available until their backlog drains.

### Deployment and verification

Obtain deployment approval naming the Echo and Iggy targets and the operations
below before applying them. Integration URLs can refer to other Iggy servers;
include those destinations in the approved scope. Apply the updated Echo binary
before running its topic command. Serialize this work with integration edits
and other topic configuration changes, because Iggy's update API sends the full
set of topic settings.

1. Inventory current and historical destinations, existing topic settings,
   cleaner state, size limits, and consumer/group committed offsets. Confirm
   consumers have processed any backlog that must be preserved. The cleaner
   also enforces existing size limits, which may delete data younger than
   30 days. The credentials stored on each integration must be allowed to read
   its streams/topics, create them when missing, and update topic settings;
   `--topics-only` does not grant those rights. Any required permission changes
   need approval before reconciliation.
2. With cleanup disabled, run the topic command above. If cleanup is already
   enabled, disabling it requires approval for the affected server's config
   change and restart first. Read both topics through Iggy's topic API for
   every integration: `message_expiry` must be `2592000000000` microseconds.
   Verify names, partition counts, compression, replication factors, size limits,
   and user permissions against the inventory before continuing.
3. For Apache Iggy `0.10.3-edge.3`, merge the following values into the existing
   sections of the `iggy-config-<server>` Bitwarden note, following the
   [pinned server configuration](https://github.com/apache/iggy/blob/iggy-0.10.3-edge.3/core/server/config.toml):

   ```toml
   [data_maintenance.messages]
   cleaner_enabled = true
   interval = "1 m"
   ```

   Echo supplies explicit topic expiry, so changing the server-wide
   `[system.topic].message_expiry` default is unnecessary. The debug template
   sets that default to `"30 days"`; copying it to another server also affects
   newly created topics that use the server default.
4. Deploy the approved note with `just deploy-config-iggy --server <server>`
   (this recipe also updates the target firewall), then restart `echo-iggy` on
   that server. Confirm the service is healthy, its startup log reports the
   message cleaner is enabled, and both topic settings survived the restart.
   Monitor cleanup logs, disk use, and consumer progress before the next target.

The topic command stops on the first error. Earlier topics may already have
been reconciled, including the first topic of a failed integration. Stop rollout,
inspect the error and actual topic state, and obtain approval for recovery
outside the original scope. Repeating the command is idempotent: topics already
at 30 days are not updated. Keep cleanup disabled until all intended topics
have passed verification; a successful topic update alone does not prove that
cleanup is running.

Iggy removes expired sealed segments on the cleanup interval and preserves the
active segment. A consumer or consumer group's committed offset can also block
expiry-based deletion of a segment it has not passed; stale offsets can retain
data indefinitely. Check for `blocked from expiry-based deletion` warnings and
resolve the consumer backlog before approving any offset reset or consumer
removal. These are destructive operations, not automatic reconciliation steps.
See the [pinned cleaner implementation](https://github.com/apache/iggy/blob/iggy-0.10.3-edge.3/core/server/src/shard/system/segments.rs).

Expiry uses Iggy's message timestamps, rather than the interception timestamps
inside event payloads. Segment boundaries and consumer offsets mean this policy
is not a hard disk-usage bound. Once enabled, existing expired segments become
eligible for deletion. Disabling the cleaner and restarting the server prevents
further cleanup but cannot recover deleted data.

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
