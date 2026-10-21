# Settlement recalculation

AOR boundaries, settlement-source configuration, and group AOR assignments can
change over time. Editing, importing, deleting, or reassigning an AOR preserves
existing message settlement links. New or edited message locations are resolved
using the current configuration.

To explicitly recalculate existing links, run:

```bash
wdintel-rs --mode=live oneoff-recalculate-inbox-settlements \
  --since-ts '2026-10-01T00:00:00' --till-ts '2026-10-02T00:00:00'
```

Times use the configured local timezone; the start is inclusive and the end is
exclusive. With neither bound, the command processes today. An omitted bound is
open-ended when the other bound is supplied. The previous command name,
`oneoff-link-inbox-settlements`, remains available.

The command recalculates both matched and unmatched locations against the current
Battle Line and AOR configuration, commits bounded batches, and reports progress.
It updates statistics and queues Iggy link changes for enabled integrations.
Completed batches remain committed if it stops; rerun the same range to finish.
Run it on a deployed environment only after obtaining approval for the target and
time range.

## Iggy settlement events

Settlement writers explicitly queue link/unlink changes in the same PostgreSQL
transaction as the link change. Location reconciliation, the settlement worker,
message reassignment, and the manual recalculation command all use this path.
Writers lock all existing settlement rows for a message before capturing its
previous links, including when several locations resolve to the same settlement.
Manual recalculation emits only the difference between the initial and final
settlement IDs, including when location rows must be added or removed. Repeating
a recalculation with unchanged results emits no settlement events.
Events describe changes to the message's distinct settlement IDs: deleting one
of several links to the same settlement does not unlink that settlement. No
settlement event is queued when no publisher is enabled.

Migration `m20261021_091705_remove_iggy_settlement_trigger` removes only the Iggy
settlement capture trigger and its function. It does not rewrite settlement rows
or require an analytics resnapshot. Deploy the matching API and background-worker
binaries together with the migration: older binaries rely on the removed trigger.
The separate trigger that requeues a link after its canonical settlement is
deleted remains installed. Direct SQL changes and foreign-key cascades no longer
create Iggy settlement events; use the Rust writer paths. The application's
existing item-deletion events still remove deleted
messages from consumers.

## Deployment and recovery

After explicit approval for the target, coordinate this update in a maintenance
window. A rolling update is unsafe: old writers lose events after the trigger is
removed, and new writers duplicate events while the old trigger remains.

1. Stop the API (`wdintel-rs`) and background worker (`wdintel-rs-bgworker`) on
   every host writing to the target database. Pause any settlement oneoffs and
   other ingestion processes using the old binaries; wait for their in-flight
   transactions to finish.
2. Install the matching binaries on all writer hosts while the processes remain
   stopped. Run `wdintel-rs --mode=live migrate` once with the new binary. This
   trigger-only migration declares no analytics table changes and requires no
   PeerDB backfill or resnapshot.
3. Verify that `m20261021_091705_remove_iggy_settlement_trigger` appears in
   `seaql_migrations` and that `pg_trigger` has no
   `sigint_inbox_item_settlement_capture_iggy_link` trigger. Start the matching
   API and background workers only after both checks pass.
4. Verify ingestion, settlement-worker progress, Iggy outbox delivery, and normal
   analytics health. AOR edits must retain historical links; an approved narrow
   recalculation must deliver only the changed distinct settlement IDs. Stop
   writers if migration state or event delivery is inconsistent.

If migration or activation fails, keep writers stopped and inspect the migration
record and trigger together before choosing a recovery. To return to older
binaries, obtain approval for the rollback target and commands, reverse this
migration using the migration runner while writers remain stopped, verify the
trigger was restored, then install and start the older API and worker together.
Do not start older writers against the trigger-free schema, or new writers
against the restored trigger. A binary rollback does not undo recalculated links
or already queued events; review any additional repair separately.
