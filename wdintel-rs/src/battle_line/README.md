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

## Settlement election

Candidate loading reads canonical settlements, aliases, coordinates, and
distances from the active Battle Line/AOR segment before calling the pure
election in `settlement_clusters.rs`. Candidates retain the existing west/east
distance limits.

Without an anchor, each distinct normalized location name has one vote,
including names with no eligible candidates. The election first maximizes the
number of names whose candidates are all less than 50 km apart, then minimizes
their total pairwise distance and total distance to the Battle Line. A result
requires strictly more than half of all names. Unfitting names remain
unresolved; tied best results leave the whole set unresolved. Distances within 1
mm of the minimum at each scoring level count as tied, independently of candidate
order. One name with several eligible canonical settlements remains
unresolved. The search examines at most 100,000 states and 64 names; exceeding
either bound leaves the set unresolved.

`sigint_network_settlement` holds the same pending/resolved/unresolved state for
network locations. Database triggers reconcile the complete normalized name set
on network creation, location edits, and activity changes, preserve decisions for
unchanged name sets, and rebuild it on network restoration. The migration queues
every existing non-deleted network with location names, including archived and
scheduled networks. This PostgreSQL-only table is excluded from analytics
replication. The settlement worker processes networks before inbox items using
the same candidate loader and pure election. Every processed pending network
set queues recalculation, including when all names become unresolved. Frequency
tasks also visit messages currently assigned to competing networks. The network
worker requeues unresolved inbox locations in its existing bounded message
batches, including after the last anchor disappears. Canonical settlement
deletion requeues its network links.
Network AOR link changes, AOR settlement-source configuration changes, and AOR
deletion/restoration requeue the affected network location sets, with network
locks serializing edits against resolution. Unchanged source selections preserve
existing network decisions; removing a selection requeues against the defaults.

Resolved locations of linked, non-deleted networks anchor inbox names. Anchored
sets maximize matched names, minimize total distance to the nearest anchor, then
minimize pairwise distances. Trusted anchors replace the majority and 50 km
requirements; ties leave the entire set unresolved. Previously resolved inbox
locations also provide context for pending names when there are no network
anchors. Explicit inbox recalculation uses network anchors too. Historical
resolved inbox links remain intact until locations change or an explicit
recalculation runs.

Network matching uses location evidence only after frequency, activity, AOR,
post, and unit filtering still leave several candidates. All distinct message
location names must have a canonical/alias candidate within 15 km of a resolved
network settlement. Exactly one matching network narrows the result; zero or
several matches preserve the earlier candidates. This lookup uses name
candidates directly, so it does not depend on the inbox settlement worker first
choosing a location. AI and coordinate-derived location updates, as well as the
unit-parser reprocessing oneoff, also recalculate network assignments.

The network direction-finding map displays a red convex hull of resolved network
settlements. One location appears as a red point; two or collinear locations
form a red line. The overlay remains visible without direction-finding
observations and is independent of their date/frequency filters. The
PostgreSQL-backed `network-points` response includes only distinct resolved
settlements with valid coordinates; unresolved names do not create map geometry.
The response also reports pending resolution. The active map retries every five
seconds while settlements remain pending, including after location or AOR edits.

Coverage: `wdintel-rs/src/battle_line/settlement_clusters/tests.rs`,
`wdintel-rs/src/battle_line/settlement_queue.rs`,
`wdintel-rs/src/sigint/network/etalon_calc/settlements/tests.rs`, and
`wdintel-rs/src/sigint/network/etalon_calc/consistency.rs`.

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
   stopped. On analytics-enabled sources, install the packaged analytics control
   bundle and exclusions, then run
   `/opt/echo-peerdb/bin/source-sync-exclusions-if-needed.sh --yes` before
   migrations. Standard Echo deployment performs this synchronization. Run
   `wdintel-rs --mode=live migrate` once with the new binary. The Iggy migration
   changes only triggers; `m20261022_080838_sigint_network_settlement` creates
   the excluded PostgreSQL-only network settlement queue. Neither requires a
   PeerDB backfill or resnapshot.
3. Verify that `m20261021_091705_remove_iggy_settlement_trigger` appears in
   `seaql_migrations` and that `pg_trigger` has no
   `sigint_inbox_item_settlement_capture_iggy_link` trigger. Verify that
   `m20261022_080838_sigint_network_settlement` is recorded, its queue and
   reconciliation triggers exist, and non-deleted network locations were queued.
   Start the matching API and background workers only after these checks pass.
4. Verify ingestion, settlement-worker progress, Iggy outbox delivery, and normal
   analytics health; run `/opt/echo-peerdb/bin/source-verify-deploy.sh` on
   analytics-enabled sources and confirm `public.sigint_network_settlement` is
   absent from raw/current/gateway tables. Initial network resolution queues
   frequency reconciliation within the configured network-history window
   (currently 367 days); monitor queue progress and database load. AOR edits
   must retain historical links; an approved narrow
   recalculation must deliver only the changed distinct settlement IDs. Stop
   writers if migration state or event delivery is inconsistent.

If migration or activation fails, keep writers stopped and inspect the migration
record and trigger together before choosing a recovery. To return to older
binaries, obtain approval for the rollback target and commands, reverse these
migrations in reverse order using the migration runner while writers remain
stopped: first remove the network settlement queue, then reverse the Iggy-trigger
migration. Verify the Iggy trigger was restored, then install and start the older
API and worker together.
Do not start older writers against the trigger-free schema, or new writers
against the restored trigger. A binary rollback does not undo recalculated links
or already queued events; review any additional repair separately.
