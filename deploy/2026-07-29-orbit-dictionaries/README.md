# ORBIT unit import

Start the importer:

```sh
sudo wdintel-rs --mode=live tui-import-orbit-units
```

Choose `IMPORT NEW ORBIT DATA REVISION` and enter the path to the ORBIT JSON
export to prepare the normalized import snapshot.

Live mode uploads the timestamped ZIP to
`orbit-import/` inside `ai_models_config.prefix` in the bucket configured by
`ai_models_config.s3_config`. Before reading the JSON, it downloads the latest
existing snapshot and reuses its dictionary UUIDs. Every snapshot contains
`orbit_units.parquet` and one Apache Parquet file for each ORBIT dictionary.

Then run the TUI on the target Echo instance and choose `Sync ORBIT units`:

```sh
sudo wdintel-rs --mode=live tui-import-orbit-units
```

From a development checkout, use `--mode=debug`; snapshots are written to and
read from `<storage_dir>/orbit-import/`:

```sh
cargo run -p wdintel-rs -- --mode=debug tui-import-orbit-units
```

`--mode=live` reads `/etc/echo/config.toml` unless `ECHO_CONFIG_PATH` is set.

The first TUI screen offers:

- prepare a new ORBIT data revision from a JSON path;
- synchronize ORBIT units;
- link ORBIT units to SIGINT units in automatic or manual mode;
- merge safe duplicate SIGINT units in automatic or manual mode;
- review all SIGINT duplicate candidates pair by pair and merge confirmed
  pairs;
- resolve non-archived unparsed unit labels in automatic or manual mode;
- reconcile linked SIGINT hierarchies and merge exact duplicates;
- erase and reimport all ORBIT data.

The synchronization action uses the latest timestamped ZIP and never asks for
a JSON path. It fails with a storage location when no snapshot exists. JSON
parsing, unknown-field rejection, hierarchy validation, dictionary
collection, and stable-ID assignment happen in `IMPORT NEW ORBIT DATA
REVISION`.
It creates, updates, reactivates, or touches every root and embedded ancestor.
`orbit_sync` records the archive MD5 and synchronization timestamp. When the
latest archive has the same MD5, the TUI warns the operator and asks whether to
proceed with database-only synchronization.

The normalizer discovers dictionary values in both root units and embedded
parents. It retains prior dictionary entries, reuses IDs by `(key, name)`, and
generates UUIDs only for new entries. The TUI inserts missing snapshot
dictionary rows before resolving units; existing PostgreSQL rows with the same
`(key, name)` remain authoritative locally.
Every value in a unit's `grouping_of_forces` array is retained through the
`orbit_unit_grouping_of_forces` many-to-many relation.

The linking action loads active SIGINT units and top-level ORBIT roots
exclusively from PostgreSQL. Manual mode reviews unlinked units. Automatic mode
also revalidates existing automatic links but preserves authoritative manual
links. It retains candidates matching every populated SIGINT echelon, gives
exact corresponding-echelon matches the maximum rating, and deducts one point
for each same-number/different-text match. Automatic mode considers only
candidates tied at the maximum rating and accepts a candidate only when it has
rating 100, is uniquely closest by Levenshtein distance, and that distance is
at most 10. Manual mode presents every structurally valid candidate for review
without a distance cutoff. The
standalone `oneoff-test-link-units` command runs the same workflow. Manual
links from `/rer-units` and `/rer-units/{id}` use the same transactional link
implementation.

The duplicate and unparsed workflows reuse that matcher directly. Duplicate
merges require every member to have one shared ORBIT link and to remain a
current match; unparsed labels can resolve only through an ORBIT unit with one
non-deleted SIGINT link. Automatic mode retains the rating-100, unique-distance,
distance-at-most-10 gate. Both workflows re-read their full candidate set and
the latest ORBIT revision under the advisory lock before writing, and skip
stale or ambiguous work.
The all-candidate duplicate review walks SIGINT duplicate-candidate pairs once,
rewrites later comparisons through any survivor selected during review, and
persists confirmed merges in bounded batches after rechecking live links.

The reconciliation action reviews proposed hierarchy enrichments, recalculates
linked-unit inconsistency flags, and merges exact-name duplicate candidates
sharing an ORBIT unit. It keeps the ORBIT advisory lock for the full run and
commits each unit or duplicate component separately, so it is safe to restart
after interruption.
When a unit also appears inside another unit's path with a different parent,
the unit's own top-level parent chain is authoritative. Conflicting
embedded-only paths still fail when the ambiguous unit is selected.

Ancestors are synchronized parent-first so complete parent trees exist before
linking. When a partial ancestor already exists, omitted source fields
preserve their stored values. Top-level rows are marked with
`is_snapshot_root`; this prevents embedded-only ancestors from becoming link
candidates. After every current snapshot row has been synchronized, older
active rows are offered for soft deletion. Quitting stale deletion preserves
the completed data synchronization without changing SIGINT links.
