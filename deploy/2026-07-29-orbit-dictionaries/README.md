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
- synchronize ORBIT units and reconcile automatic SIGINT links;
- merge duplicate SIGINT units through manual survivor review;
- review all SIGINT duplicate candidates pair by pair and merge confirmed
  pairs;
- resolve non-archived unparsed unit labels in automatic or manual mode;
- remove invalid army, corps, military-district, and army-region values;
- review SIGINT names generated from their echelon fields;
- erase and reimport all ORBIT data.

The synchronization action uses the latest timestamped ZIP and never asks for
a JSON path. It fails with a storage location when no snapshot exists. JSON
parsing, unknown-field rejection, hierarchy validation, dictionary
collection, and stable-ID assignment happen in `IMPORT NEW ORBIT DATA
REVISION`.
It creates, updates, reactivates, or touches every root and embedded ancestor.
`orbit_sync` records the archive MD5 and synchronization timestamp. When the
latest archive has the same MD5, the TUI warns the operator and asks whether to
proceed with database-only synchronization. After the data transaction commits,
the action automatically revalidates automatic links while preserving manual
links and suppressed decisions. It imports missing ORBIT ancestors, reconciles
SIGINT echelons without regenerating names, and refreshes duplicate-candidate
state and parent activity when a link changes. It then creates and links an
inactive SIGINT unit for every remaining supported, non-deleted ORBIT unit;
generative ancestors of active matched units remain active.

The normalizer discovers dictionary values in both root units and embedded
parents. It retains prior dictionary entries, reuses IDs by `(key, name)`, and
generates UUIDs only for new entries. The TUI inserts missing snapshot
dictionary rows before resolving units; existing PostgreSQL rows with the same
`(key, name)` remain authoritative locally.
Every value in a unit's `grouping_of_forces` array is retained through the
`orbit_unit_grouping_of_forces` many-to-many relation.

Automatic linking loads non-deleted SIGINT units and top-level ORBIT roots
exclusively from PostgreSQL. It retains candidates matching every populated
SIGINT echelon, gives
exact corresponding-echelon matches the maximum rating, and deducts one point
for each same-number/different-text match. It considers only
candidates tied at the maximum rating and accepts a candidate only when it has
rating 100, is uniquely closest by Levenshtein distance, and that distance is
at most 10. Manual links remain available from `/rer-units` and
`/rer-units/{id}` through the same transactional link implementation.

The duplicate and unparsed workflows reuse that matcher directly. Duplicate
merges require every member to have one shared ORBIT link and to remain a
current match. They are always manual: the operator selects a survivor and
confirms its projected field values before persistence. Unparsed labels can
resolve only through an ORBIT unit with one non-deleted SIGINT link; automatic
mode retains the rating-100, unique-distance, distance-at-most-10 gate. Both
workflows re-read their candidate data and the latest ORBIT revision under the
advisory lock before writing, and skip stale or ambiguous work.
The all-candidate duplicate review walks SIGINT duplicate-candidate pairs once,
rewrites later comparisons through any survivor selected during review, and
persists confirmed merges in bounded batches after rechecking live links.

The hierarchy-cleanup action can automatically or manually clear blacklisted
army and corps values, including `УВ(с)`, `ТН`, and `МВО`, as well as army,
corps, military-district, and army-region values absent from the unit's single
linked ORBIT generative hierarchy. It also removes `other` values from names
without clearing their hierarchy fields. The generated-name action offers
automatic application or manual review of every non-deleted SIGINT unit whose
current name differs from its echelon-generated name. The shared naming rule
excludes `other`, blacklisted army and corps values, military district, and army
region. Automatic mode in both actions can target active units, inactive units,
or both. A unit with no populated echelon below corps keeps its current name; a
newly imported ORBIT unit in that case uses its full ORBIT name.
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
