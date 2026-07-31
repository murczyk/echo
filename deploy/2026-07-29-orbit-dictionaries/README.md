# ORBIT unit import

Prepare the normalized import snapshot from the ORBIT JSON export:

```sh
sudo wdintel-rs --mode=live oneoff-prepare-orbit-import \
  --path /path/to/orbit-export.json
```

Live mode uploads the timestamped ZIP to
`orbit-import/` in the bucket configured by
`ai_models_config.s3_config`. Before reading the JSON, it downloads the latest
existing snapshot and reuses its dictionary UUIDs. Every snapshot contains
`orbit_units.parquet` and one Apache Parquet file for each ORBIT dictionary.

Then run the TUI on the target Echo instance:

```sh
sudo wdintel-rs --mode=live tui-import-orbit-units
```

From a development checkout, use `--mode=debug`; snapshots are written to and
read from `<storage_dir>/orbit-import/`:

```sh
cargo run -p wdintel-rs -- --mode=debug oneoff-prepare-orbit-import \
  --path /path/to/orbit-export.json
cargo run -p wdintel-rs -- --mode=debug tui-import-orbit-units
```

`--mode=live` reads `/etc/echo/config.toml` unless `ECHO_CONFIG_PATH` is set.

The first TUI screen offers:

- synchronize ORBIT units and rebuild SIGINT links;
- search an ORBIT unit by an exact Echo SIGINT unit full name.

The synchronization action uses the latest timestamped ZIP and never asks for
a JSON path. The TUI fails with a storage location when no snapshot exists.
JSON parsing, unknown-field rejection, hierarchy validation, dictionary
collection, and stable-ID assignment happen in `oneoff-prepare-orbit-import`.
It creates, updates, reactivates, or touches every root and embedded ancestor
before matching. `orbit_sync` records the archive MD5 and synchronization
timestamp. When the latest archive has the same MD5, the TUI warns the operator
and asks whether to proceed with database-only link rebuilding.

The search option asks for the SIGINT full name first. If no active,
non-deleted `sigint_unit` has that normalized full name, it prints the result
without loading ORBIT data. Otherwise it ranks roots from the latest recorded
database synchronization by matching hierarchy segments and root-echelon
distance, and shows all equally closest results with their ORBIT unit IDs,
operational full, generative full, and original names. Use Up/Down and Enter to
select a result. This manual selection replaces any existing ORBIT links for
that SIGINT unit with the selected root without changing ORBIT unit data.

The normalizer discovers dictionary values in both root units and embedded
parents. It retains prior dictionary entries, reuses IDs by `(key, name)`, and
generates UUIDs only for new entries. The TUI inserts missing snapshot
dictionary rows before resolving units; existing PostgreSQL rows with the same
`(key, name)` remain authoritative locally.
Every value in a unit's `grouping_of_forces` array is retained through the
`orbit_unit_grouping_of_forces` many-to-many relation.

Only ORBIT roots whose own name or alias matches the active Echo SIGINT unit's
lowest populated echelon are retained. Remaining normalized full-path names are
used only to compare parents and score candidates across both operational and
generative paths, even when an ORBIT descriptor has the wrong echelon. If the
SIGINT unit has a parent path, at least one parent name or alias must also appear
in either ORBIT path. Known echelon conflicts still reject a candidate. Before
comparison, matching removes the configured `ТерО`, `ТрО`, and `(ат)` fragments
from SIGINT names case-insensitively; ORBIT names remain unchanged. At the army
echelon, a name starting with a number and whose remaining text ends in `А` is
compared as `<number> А`, so variants such as `58 А`, `58 ОА`, and `58 ЗВА` are
equivalent. Extra full-name segments without descriptors are allowed when the
supplied descriptors remain in hierarchy order. When several SIGINT units
match, an exact root-echelon match wins, followed by the candidate with the most
matching names. An unresolved tie with divergent parent paths is skipped; equal
matches whose parent paths are ordered extensions select only the shortest
path, while same-path duplicates select the lowest ID. A longer path wins when
SIGINT parent evidence ranks it higher. After synchronization, matching loads
top-level roots and parent chains exclusively from PostgreSQL. The rebuilt link
set replaces all existing links, including links produced by older matching
rules. These links drive the admin-only ORBIT indicator and separate
unit-details cards.
When a unit also appears inside another unit's path with a different parent,
the unit's own top-level parent chain is authoritative. Conflicting
embedded-only paths still fail when the ambiguous unit is selected.

Ancestors are synchronized parent-first so complete parent trees exist before
link rebuilding. When a partial ancestor already exists, omitted source fields
preserve their stored values. Top-level rows are marked with
`is_snapshot_root`; this prevents embedded-only ancestors from becoming link
candidates. After every current snapshot row has been synchronized, older
active rows are offered for soft deletion. Quitting stale deletion preserves
the completed data synchronization and still rebuilds links from the current
database snapshot.
