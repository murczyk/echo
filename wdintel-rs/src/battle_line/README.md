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
