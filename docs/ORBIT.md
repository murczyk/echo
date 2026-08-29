# Working with ORBIT data

ORBIT unit ingestion has two separate stages:

1. Normalize an ORBIT JSON export through the TUI into a timestamped ZIP of
   Apache Parquet files.
2. Synchronize the latest normalized snapshot into PostgreSQL.

Linking is a separate TUI action that reads both ORBIT and SIGINT units from
PostgreSQL.

The preparation action reads a JSON export. Synchronization actions always read
the latest normalized snapshot from configured storage.

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

Run `tui-import-orbit-units` as described below and choose
`IMPORT NEW ORBIT DATA REVISION`, then enter the path to the JSON export.

The path is read by the process running `wdintel-rs`. Use an absolute path and
make sure that user can read the file. The action validates the JSON and its
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

The synchronization actions download and unpack the newest timestamped
snapshot and fail if no snapshot exists. Database-mutating import sessions are
serialized, so a second importer waits until the active import releases its
PostgreSQL advisory lock. The first screen offers five workflows.

### IMPORT NEW ORBIT DATA REVISION

Enter the path to an ORBIT JSON export. This prepares and stores the normalized
snapshot without modifying PostgreSQL.

### Sync ORBIT units

This workflow first creates, updates, or reactivates every unit represented by
the Parquet snapshot. Top-level roots and embedded ancestors are persisted
parent-first, and `is_snapshot_root` distinguishes matchable roots from parent
descriptors. Active rows absent from the snapshot are then offered for soft
deletion.

Each completed data phase writes the archive MD5 and its synchronization time
to `orbit_sync`. When the latest archive MD5 is already recorded, the TUI warns
the operator and asks whether to proceed. Proceeding skips all Parquet-to-table
work; cancelling leaves the database unchanged. This workflow does not create
or replace SIGINT links.

### Link ORBIT units to SIGINT units

This is the only automatic linking workflow. It reads active, non-deleted
SIGINT units and roots from the latest synchronized ORBIT revision from
PostgreSQL. Manual mode reviews only unlinked units. Automatic mode also
revalidates existing automatic links while preserving authoritative manual
links. Choose a mode when the workflow starts:

- automatic links a unit only when one rating-100 candidate is uniquely closest
  by Levenshtein distance and that distance is at most 10;
- manual opens the interactive review for every structurally valid candidate,
  without a Levenshtein-distance cutoff.

Accepted links use the same transactional implementation as manual linking in
`/rer-units` and `/rer-units/{id}`. That implementation validates both units,
creates the link, imports missing ORBIT ancestors, reconciles the SIGINT
hierarchy and duplicate-candidate state, and updates parent activity.

### Reconcile linked SIGINT units and merge exact duplicates

This workflow reviews proposed hierarchy enrichments for linked SIGINT units.
Accepted attributes are applied, inconsistency flags are recalculated for all
linked units, and exact-name duplicate candidates sharing an ORBIT unit are
merged. The ORBIT advisory lock is held for the full run while individual unit
and duplicate-component transactions are committed separately, so an
interrupted run can be restarted safely.

### Erase and reimport all ORBIT data

After the operator types `REIMPORT`, this workflow atomically truncates all
seven `orbit_*` tables, including synchronization history and ORBIT-to-SIGINT
links, then imports the latest snapshot. A failure rolls back the whole
reimport. Existing SIGINT units are not deleted; run the linking workflow
afterward.

Common controls are:

- Up/Down, Home/End: select an item;
- Enter: accept;
- `s`: skip;
- `a`: skip all remaining stale deletions when offered;
- Page Up/Page Down: scroll details;
- `q`, Escape, or Ctrl-C: quit.

## Link from the standalone command

The same database-backed linking workflow remains available as a standalone
one-off:

```sh
sudo wdintel-rs --mode=live oneoff-test-link-units
```

The command first asks for automatic or manual mode. Manual mode evaluates each
unlinked database SIGINT unit against the latest synchronized ORBIT revision
before opening one interactive review session. It shows each
unit's non-empty echelons from smaller to larger. Every structurally valid
candidate is shown regardless of its rating or Levenshtein distance; units
without a match are skipped automatically. Each candidate shows the full
SIGINT and ORBIT names as red and green word-level highlights for mismatched
and matched text, along with
their Levenshtein distance. The ORBIT UUID is shown to distinguish records
sharing a generative hierarchy. Units with multiple
matches are reviewed before units with a single match; each group and its
candidates are ordered by distance from shortest to longest.

At most five candidates are shown at once. Use Enter, `y`, or `1` to accept the
first visible candidate, or `2` through `5` to accept another visible candidate.
Use `f` and `b` to show the next or previous five candidates, `n` to deny all
candidates (`0` does the same), and Up/Down or Page Up/Page Down to scroll. Use
`q`, Escape, or Ctrl-C and confirm to stop early. The terminal is restored
before the command prints the accepted, denied, and unreviewed counts.

Accepted choices are written after the terminal is restored. Denied and
unreviewed units remain unlinked. If an accepted unit became linked during the
review, persistence skips it, reports it as already linked, and continues.

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

ORBIT information is visible only when `can_view_orbit_data` permits it, which
means the user has either the `Admin` or `Orbit` role. The `Orbit` role grants
this access without broader administrator privileges. Other users always
receive `has_orbit: false` in the RER units response and no ORBIT detail cards.

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
- unexpected matches: use manual linking mode to inspect candidate UUIDs and
  full paths before accepting a link.

The deployment-oriented checklist is in the
[ORBIT import runbook](../deploy/2026-07-29-orbit-dictionaries/README.md).
