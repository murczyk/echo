# Working with ORBIT data

ORBIT unit ingestion has two separate stages:

1. Normalize an ORBIT JSON export into a timestamped ZIP of Apache Parquet
   files.
2. Synchronize the latest normalized snapshot into PostgreSQL, then rebuild
   SIGINT links from the synchronized database rows through the TUI.

Do not run the TUI directly against a JSON export. It always reads the latest
normalized snapshot from configured storage.

## Source JSON

The source must be a top-level array of ORBIT unit objects. Every unit requires
a UUID `unit_id`, and every top-level unit requires a non-blank
`operational_unit_name_full`. All other supported fields are optional:

- names: `unit_name`, `unit_name_original`, `unit_name_short`, and
  `generative_unit_name_full`;
- identifiers: `unit_number`, `unit_alternate_names`, and
  `unit_alternate_numbers`;
- dictionaries: `unit_echelon`, `combat_unit_type`, and
  `grouping_of_forces`;
- hierarchy: `operational_parent_units`, `generative_parent_units`, and
  `path_level` on embedded parent objects.

`unit_echelon` and `combat_unit_type` are either `null` or one object containing
`key` and `name`. `grouping_of_forces` accepts `null`, one such object, or an
array because a unit can belong to multiple force groupings. Alternate names
and numbers accept either an array of strings or a comma-separated string.

Unknown object properties are rejected so upstream schema changes cannot be
silently discarded. Repeated appearances of the same unit UUID must not contain
conflicting non-null unit details.

For each top-level unit object, that object's operational and generative parent
arrays are authoritative. A conflicting claim made only by embedding the same
unit in another object's parent chain is ignored when an authoritative
top-level object exists. Conflicting embedded parent claims still fail when the
unit has no top-level object. Cycles and references to missing hierarchy units
also fail.

## Prepare a snapshot

From a development checkout:

```sh
cargo run -p wdintel-rs -- --mode=debug oneoff-prepare-orbit-import \
  --path /absolute/path/to/orbit-export.json
```

In production:

```sh
sudo wdintel-rs --mode=live oneoff-prepare-orbit-import \
  --path /absolute/path/to/orbit-export.json
```

The path is read by the process running `wdintel-rs`. Use an absolute path and
make sure that user can read the file. The command validates the JSON and its
hierarchies, collects dictionary values, writes the archive, and prints its
final storage location.

Each archive is named `orbit-import/YYYYMMDD_HHMMSS_microseconds.zip` and
contains:

- `orbit_units.parquet`;
- `orbit_grouping_of_forces.parquet`;
- `orbit_combat_unit_type.parquet`;
- `orbit_unit_echelon.parquet`.

Before normalizing a new export, the command reads the latest existing snapshot.
It reuses dictionary UUIDs by `(key, name)` and retains older dictionary entries
that are absent from the new export. Do not delete the latest snapshot or edit
dictionary UUIDs unless deliberately starting a new dictionary identity set.

In live mode, archives are stored under `orbit-import/` inside
`ai_models_config.prefix` in the S3 bucket from `ai_models_config.s3_config`.
In debug and test modes, they are stored under
`<storage_dir>/orbit-import/`. Live mode reads `/etc/echo/config.toml` by
default; set `ECHO_CONFIG_PATH` to use another configuration file.

## Import through the TUI

From a development checkout:

```sh
cargo run -p wdintel-rs -- --mode=debug tui-import-orbit-units
```

In production:

```sh
sudo wdintel-rs --mode=live tui-import-orbit-units
```

The importer downloads and unpacks the newest timestamped snapshot. It fails
before starting if no snapshot exists. Database-mutating import sessions are
serialized, so a second importer waits until the active import releases its
PostgreSQL advisory lock. The first screen offers two workflows.

### Sync ORBIT units and rebuild links

This workflow first creates, updates, or reactivates every unit represented by
the Parquet snapshot. Top-level roots and embedded ancestors are persisted
parent-first, and `is_snapshot_root` distinguishes matchable roots from parent
descriptors. Active rows absent from the snapshot are then offered for soft
deletion.

Each completed data phase writes the archive MD5 and its synchronization time
to `orbit_sync`. When the latest archive MD5 is already recorded, the TUI warns
the operator and asks whether to proceed. Proceeding skips all Parquet-to-table
work and only rebuilds links from PostgreSQL; cancelling leaves data and links
unchanged.

After synchronization, active `sigint_unit` rows are matched only against roots
from the latest recorded database sync. Both generative and operational full
paths contribute parent evidence.
Root echelon, normalized army abbreviations, configured SIGINT-only name
fragments, and hierarchy distance are considered when ranking candidates.
Ambiguous candidates with divergent parent paths are skipped. Among equally
close candidates whose paths are ordered extensions, only the shortest path is
selected unless SIGINT parent evidence ranks a longer path higher.
ORBIT-to-SIGINT links are replaced from those database-derived matches even
when the stale-deletion review is quit.

### Search by SIGINT unit name

Enter the exact full name assembled from the SIGINT unit's populated company,
battalion, regiment, division, and army fields. If no active SIGINT unit has
that normalized full name, the command reports it without searching ORBIT.

The search reads roots and parent chains from the latest recorded database sync
instead of reopening Parquet. The TUI displays all equally closest candidates
with their ORBIT UUID, operational full name, generative full name, and original
name. Select a result with Up/Down and Enter. That SIGINT unit's existing ORBIT
links are replaced with the selected root; ORBIT unit data is not changed.

Common controls are:

- Up/Down, Home/End: select an item;
- Enter: accept or link;
- `s`: skip;
- `a`: skip all remaining stale deletions when offered;
- Page Up/Page Down: scroll details;
- `q`, Escape, or Ctrl-C: quit.

## PostgreSQL data model

Imported data is stored in seven tables:

- `orbit_unit`: unit attributes, snapshot-root marker, soft-deletion state, and
  operational and generative parent UUIDs;
- `orbit_unit_echelon`: echelon dictionary;
- `orbit_combat_unit_type`: combat-unit-type dictionary;
- `orbit_grouping_of_forces`: force-grouping dictionary;
- `orbit_unit_grouping_of_forces`: many-to-many unit/grouping links;
- `orbit_unit_sigint_unit`: many-to-many links between ORBIT and Echo SIGINT
  units;
- `orbit_sync`: synchronization timestamp and MD5 of each applied archive.

The TUI inserts dictionary rows missing from PostgreSQL. An existing database
row with the same `(key, name)` remains authoritative locally. Units are soft
deleted through `orbit_unit.deleted`; link matching reconstructs hierarchy from
the latest synchronized PostgreSQL rows.

These tables are operational PostgreSQL data and are excluded from PeerDB
replication.

## Application behavior

ORBIT information is currently visible only when
`can_view_orbit_data` permits it, which currently means the user has the admin
role. Other users always receive `has_orbit: false` in the RER units response
and no ORBIT detail cards.

For permitted users, a Delta icon marks linked rows in the RER unit list. The
unit details page renders one separate `Дані із Orbit` card for every active
linked ORBIT unit and provides a link to:

```text
https://delta.mil.gov.ua/orbit/units/{unit_id}/organizational-structure
```

Soft-deleted ORBIT units are neither marked nor rendered.

## Troubleshooting

- `No such file or directory`: verify the absolute JSON path on the host where
  the preparation command runs and its read permissions.
- `no ORBIT import snapshot exists`: prepare a snapshot in the same mode and
  with the same configuration used by the TUI.
- `unknown properties`: update the importer for the new source schema or remove
  unintended fields; do not silently ignore them.
- dictionary decoding errors: verify that dictionary values use `{ "key":
  ..., "name": ... }`; `grouping_of_forces` may be an object or an array.
- conflicting unit values or parents: inspect every occurrence of the reported
  UUID. A unit's own top-level object resolves conflicting embedded parent
  claims, but conflicting top-level objects are invalid.
- unexpected matches: use the search workflow to inspect candidate UUIDs and
  full paths before linking one manually.

The deployment-oriented checklist is in the
[ORBIT import runbook](../deploy/2026-07-29-orbit-dictionaries/README.md).
