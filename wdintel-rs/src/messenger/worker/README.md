# Group message ingestion

Sender names from echo-im are synchronized for both Signal and WhatsApp in the
same transaction that acknowledges incoming messages. The synchronized profile
is used for display before legacy echo-im sender records, so a WhatsApp device
suffix change cannot restore an old name from the normalized sender ID. Blank
incoming names preserve the last known name. A nonblank echo-im name replaces
the full display name, including any surname left from an older profile.

Regression coverage: `wdintel-rs/src/messenger/worker/mod.rs`
(`sender_renames_3957_follow_echo_im_for_signal_and_whatsapp` and
`sender_names_3957_use_echo_im_when_synced_profile_is_empty`).

In `/admin/directions-neo`, assigned and orphan group editors expose
«Отримувати нові повідомлення з месенджера». This stores the nullable
`signal_group.fetch_new_messages` flag. The column has no SQL default; `NULL`
means enabled. The setting applies to the group across messenger accounts.

When explicitly `false`, the receiver acknowledges new echo_im messages without
queueing them. Update snapshots still reach the queue: edits and deletions of
previously imported messages continue through reconciliation, including legacy
links. Queued snapshots with no existing link are discarded before processing
attachments. Eligibility is checked when processing starts and again before a
new import after staging media.

Automatic recovery advances past disabled groups without recording their
messages as missing. Scheduled recovery resolves already imported messages and
retains deleted/duplicate terminal statuses; attempts to import missing messages
fail with an explanation while the flag is disabled. Recovery rechecks the
setting before staging media and within the import transaction.

Manual message creation in the web UI and group metadata synchronization
(including renames and deletions) remain available. Turning the setting on
resumes consumption of new messages; it does not schedule a historical import.

Callsign highlighting sends one batch lexeme request for all requested
callsigns, preserving their order and the existing token offsets and morphology.
An incomplete batch response fails processing instead of silently dropping
callsigns. This replaces per-callsign HTTP waits inside the import transaction;
the existing HTTP, database and queue retry limits remain unchanged.

Settlement parsing allows fuzzy matches only in the first five physical message
lines, including blank lines, with a shared budget of 1,000 normalized candidate
characters, counting a separator per word. Oversized words and multiword fuzzy
spans cannot exceed the budget. Exact matches remain available throughout the
message, including names crossing the budget boundary. This bounds the
full-message fallback used when a unit field has no location field, so long
message bodies do not repeatedly traverse the entire settlement dictionary
while holding the import transaction open.

Reprocessing acquires/enqueues the palette highlight job before changing
derived point tokens, matching the highlight worker's lock order. Both the
queue change and token invalidation remain in the same transaction, so a failed
import does not lose the pending highlight. Existing failed messenger snapshots
retain their normal retry schedule; deployment does not purge or reset them.

The migration declares `replicated_snapshot` with `targeted_resnapshot: true`
for `public.signal_group`. Deployment automatically reconciles only that table's
PeerDB mapping, including quiet and empty tables, then refreshes current-state
views and the PostgreSQL gateway. Require the analytics health check to pass
before deploying the next server; retry interrupted reconciliation with
`/opt/echo-peerdb/current/bin/source-verify-deploy.sh`.
