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

- import new ORBIT units from the latest normalized snapshot;
- search an ORBIT unit by an exact Echo SIGINT unit full name.

Both actions use the latest timestamped ZIP and never ask for a JSON path. The
TUI fails with a storage location when no snapshot exists. JSON parsing,
unknown-field rejection, hierarchy validation, dictionary collection, and
stable-ID assignment happen in `oneoff-prepare-orbit-import`.

The search option asks for the SIGINT full name first. If no active,
non-deleted `sigint_unit` has that normalized full name, it prints the result
without loading a snapshot. Otherwise it ranks roots from the latest snapshot
by matching hierarchy segments and root-echelon distance, and shows all equally
closest results with their ORBIT unit IDs, operational full, generative full,
and original names. Use Up/Down and Enter to select a result. The selected root
and both parent chains are imported parent-first without the regular review or
stale deletion pass. This manual selection replaces any existing ORBIT links
for that SIGINT unit with the selected root.

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
matches whose parent paths are ordered extensions of one another are all
retained, while same-path duplicates select the lowest ID. Generative and
operational ancestors of matched roots are included. After a completed review,
active imported roots are linked to the selected active Echo SIGINT unit. One
SIGINT unit can therefore link to multiple equally close ORBIT roots when one
hierarchy contains additional intermediate parents. A completed import replaces
all existing links, including links produced by older matching rules. These
links drive the admin-only ORBIT indicator and separate unit-details cards.
When a unit also appears inside another unit's path with a different parent,
the unit's own top-level parent chain is authoritative. Conflicting
embedded-only paths still fail when the ambiguous unit is selected.

Ancestors are imported parent-first without confirmation so the complete parent
tree exists before matched children are reviewed. New ancestors are created,
changed ancestors are updated, and deleted ancestors are reactivated
automatically. When a partial ancestor already exists, omitted source fields
preserve their stored values. Interactive create/update/reactivate prompts are
shown only for ORBIT roots selected by SIGINT matching. Rejecting a selected
parent also skips dependent descendants. Review headers show the ORBIT
generative full path without ` / ` separators and the corresponding SIGINT full
name. The review offers:

- create or skip for new units;
- update or skip for changed units;
- reactivate or skip for deleted units;
- delete, skip, or skip all for stale active units.

Unchanged units and skipped changed/reactivation units are marked seen by
updating only `updated_at`. After review, active rows older than the import
start minus the five-second grace period are offered for soft deletion.
Confirmed changes are persisted immediately; quitting stops future work and
does not roll back earlier decisions.
