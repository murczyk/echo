# Working with ORBIT data

ORBIT unit ingestion has two stages:

1. Normalize an ORBIT JSON export through the TUI into a timestamped ZIP of
   Apache Parquet files.
2. Synchronize the latest normalized snapshot into PostgreSQL and reconcile
   automatic ORBIT-to-SIGINT links.

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
PostgreSQL advisory lock. The first screen offers fifteen workflows.

### TUI workflow conventions

ORBIT maintenance workflows that compare or merge data use a field-by-field or
word-level diff in manual mode. Matching text is green and differing text is
red; the operator must explicitly accept the proposed link, edit, or merge.
Before persistence, accepted work is reloaded under the ORBIT advisory lock and
is skipped when the compared data or match is stale.

When such a workflow changes SIGINT units, its automatic and manual modes offer
separate scopes for all active units, all inactive units, or both. Manual mode
always shows the comparison diff. Automatic mode reloads, applies, and commits
each item in its own transaction before continuing to the next item, so a later
failure does not roll back earlier completed work.

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
work; cancelling leaves the database unchanged.

After the data transaction commits, synchronization reads non-deleted SIGINT
units and roots from the latest synchronized ORBIT revision. It revalidates
existing automatic links while preserving authoritative manual links and
suppressed link decisions. A unit is linked only when one rating-100 candidate
is uniquely closest by Levenshtein distance and that distance is at most 10.
Rerunning synchronization is therefore also the supported way to retry an
interrupted link phase when the snapshot MD5 is unchanged.

Link persistence validates both units, imports missing ORBIT ancestors,
reconciles SIGINT echelons and duplicate-candidate state, and updates parent
activity. It never regenerates the current SIGINT unit name. After automatic
matching, every remaining supported, non-deleted ORBIT unit is created as an
inactive SIGINT unit and linked to its ORBIT source. Generative ancestors of
active matched units remain active.

### Link unlinked SIGINT units to ORBIT units

This workflow wraps the normal ORBIT matcher for non-deleted SIGINT units that
do not have an active ORBIT link. Automatic mode links only a unique closest
rating-100 candidate with Levenshtein distance at most 10 and can target active
units, inactive units, or both. Manual mode shows the SIGINT and ORBIT hierarchy
names as a colored word diff and permits any structurally valid candidate,
without the automatic distance cutoff. Accepted candidates are revalidated
before a manual or automatic link is written.

The former standalone `oneoff-test-link-units` command is not available; use
this workflow from `tui-import-orbit-units`.

### Link unlinked ORBIT units to SIGINT units

This workflow starts from every matchable root in the latest synchronized ORBIT
revision that has no non-suppressed link to a non-deleted SIGINT unit. It
presents matching, currently unlinked SIGINT units in the reverse direction.
Manual mode shows a colored hierarchy diff for each candidate. If no candidate
matches, the operator can create and link a new inactive SIGINT unit.

Automatic mode can search active SIGINT units, inactive SIGINT units, or both.
It links an ORBIT unit only when exactly one SIGINT unit independently passes
the normal automatic matching rules. Before it starts, the operator chooses
whether ORBIT units with no structural match should be created as inactive
SIGINT units or left unlinked. Ambiguous and unsafe matches are skipped, not
created, and every action is revalidated under the ORBIT advisory lock.

### Replace linked SIGINT echelon values with mismatched ORBIT numbers

This workflow compares every non-empty SIGINT echelon with the same echelon in
its single linked ORBIT generative hierarchy. A mismatch is proposed only when
both values contain words and numbers and their numeric parts differ; wording
differences with the same numbers are left unchanged. For example, SIGINT army
`36 А` and ORBIT army `35 А` produce a proposal to replace `36 А` with `35 А`.

Manual mode shows every mismatched echelon as a colored SIGINT/ORBIT word diff
and applies all displayed replacements only after explicit acceptance.
Automatic mode applies every current proposal and can target active SIGINT
units, inactive SIGINT units, or both. Units with zero or multiple active ORBIT
links are skipped. Before update, the link, activity scope, current SIGINT
values, and current ORBIT hierarchy are reloaded under the advisory lock; stale
manual proposals are not applied.

### Fix misplaced and unknown SIGINT echelon values

This workflow builds separate normalized identity-value sets from every ORBIT
echelon: other, team/crew, section, squad, platoon, company, battalion,
regiment, brigade, division, corps, army, group-of-armies, and army-region. It
first moves brigade values stored as SIGINT regiments and army values stored as
corps. It then validates each SIGINT army, group-of-armies
(`military_district`), and army-region field in a separate pass. A value found
in exactly one other ORBIT echelon is moved there; a value absent from every
collected ORBIT echelon is removed. Values that match their current echelon or
are ambiguous between multiple echelons are left unchanged.

Each move clears the source echelon and replaces the destination echelon with
that source value. When the destination contains the reciprocal misplaced
value, the two values are swapped atomically. Other occupied destinations are
updated only when their existing values can be classified and safely
relocated; unknown or ambiguous values are preserved by skipping the move. The
SIGINT unit name is not changed by this workflow. Manual mode presents each
incorrect source field in its own review dialog.

Automatic and manual modes can target active SIGINT units, inactive SIGINT
units, or both. Manual mode shows the current and proposed values for both
affected fields. Before update, the ORBIT revision, activity scope, and current
SIGINT values are reloaded under the advisory lock; stale manual proposals are
not applied. Quitting manual review stops the remaining passes after saving
already accepted changes.

### Review conflicting SIGINT higher-echelon values

This manual workflow treats brigade, division, corps, army, army region, and
military district names as case-insensitive unique identities. It processes
those echelons from lower to higher and their names alphabetically. For every
pair of units sharing one identity, it reviews differing higher-echelon fields
one at a time, including a populated value versus an empty value.

The operator can copy the displayed higher-echelon value from unit 1 to unit 2,
copy it from unit 2 to unit 1, select a distinct structural ORBIT value to
overwrite both units, skip the conflict, or stop. The workflow can target
active units, inactive units, or both. Accepted changes are reloaded under the
ORBIT advisory lock; a concurrent change to either displayed unit or its
activity scope makes that choice stale and leaves it untouched.
For each compared SIGINT unit, the review also lists every linked ORBIT unit's
structural (generative) hierarchy from low to high and highlights the
conflicting echelon in magenta. Operational hierarchies are not included.

### Merge duplicate SIGINT units linked to one ORBIT unit

This workflow processes the same active ORBIT-to-SIGINT duplicate groups shown
under `/admin/units?tab=duplicates`. It considers a group reviewable only when
every SIGINT unit has that one active ORBIT link and the normal linking matcher
still matches every unit to that ORBIT unit. The workflow is always manual: it
first asks which SIGINT unit to keep, then shows the projected survivor and a
field-by-field before/after diff for explicit confirmation. The selected
survivor's current name is preserved.

Before merging, each complete group and every match is loaded again under the
ORBIT advisory lock. Changed membership, links, source revision, matching
results, or unit contents cause the group to be skipped as stale. Multi-ORBIT
and matcher-rejected groups are always left for explicit administration.

### Resolve unparsed unit labels through ORBIT links

This workflow processes non-archived labels from
`/admin/units?tab=unparsed`. The operational unit parser converts each label to
an echelon hierarchy, including brigade and corps levels, then the normal ORBIT
linking matcher scores it without a second matching implementation. Automatic
mode preserves the full rating, distance, and ambiguity checks before
considering whether that ORBIT unit has exactly one active, non-deleted SIGINT
link. Manual mode also presents a uniquely matched ORBIT root with no SIGINT
link; accepting it imports and links the SIGINT unit before resolving the
label.

Accepted labels are re-matched under the advisory lock, added as SIGINT unit
aliases, and returned to the existing failed-unit worker for reprocessing. A
selected inactive SIGINT unit is activated through the normal audited unit
path. In automatic mode, guarded radio-network and location-only labels that do
not contain a valid parsed hierarchy are archived. Archived labels and labels
that changed during review remain untouched.

### Remove invalid army/corps and higher echelons from SIGINT unit names

This workflow finds blacklisted army and corps values `УВ(с)`, `УВ`, and `ТН`,
as well as army, corps, military-district, and army-region values
absent from the unit's single linked ORBIT generative hierarchy.
Automatic mode applies every safe proposal; manual mode shows the current and
proposed name diff one unit at a time. Accepted changes clear invalid echelon
fields and remove their complete phrases from the SIGINT name. An `other` value
is removed from the name without clearing its hierarchy field, but matching or
overlapping complete values belonging to other echelons are retained. Automatic
mode can target active units, inactive units, or both. Units whose names would
not change are left untouched, including their echelon fields.

### Review SIGINT unit names generated from echelons

This workflow checks every non-deleted SIGINT unit in ID order. Generated names
exclude `other`, blacklisted army and corps values even when legacy data stores
them in lower-echelon fields, military district, and army region. Automatic
mode applies every current proposal; manual mode shows a colored
current/generated word diff and offers to apply, skip, or stop.
Automatic mode can target active units, inactive units, or both. Accepted
changes update only the name. In manual mode, a concurrent change to
the name or any echelon makes the reviewed proposal stale and leaves it
untouched. An empty generated name is never proposed. A unit with no populated
echelon below corps keeps its current name; a newly imported ORBIT unit in that
case uses its full ORBIT name.

### Erase and reimport all ORBIT data

After the operator types `REIMPORT`, this workflow atomically truncates all
seven `orbit_*` tables, including synchronization history and ORBIT-to-SIGINT
links, then imports the latest snapshot. A failure rolls back the whole
data reimport. Existing SIGINT units are not deleted. Automatic links are
rebuilt after the data transaction commits, then unmatched ORBIT units are
created as inactive SIGINT units.

Common controls are:

- Up/Down, Home/End: select an item;
- Enter: accept;
- `s`: skip;
- `c`: create a new inactive SIGINT unit when an unlinked ORBIT unit has no
  match;
- `a`: skip all remaining stale deletions when offered;
- Page Up/Page Down: scroll details;
- `q`, Escape, or Ctrl-C: quit.

## Direct review commands

The duplicate and unparsed workflows also have direct TUI commands:

```sh
sudo wdintel-rs --mode=live tui-merge-orbit-unit-duplicates
sudo wdintel-rs --mode=live tui-resolve-orbit-unparsed-units
```

Pass `--dry-run` to either command to print blocker counts and top candidate
details without prompting or changing data:

```sh
sudo wdintel-rs --mode=live tui-merge-orbit-unit-duplicates --dry-run
sudo wdintel-rs --mode=live tui-resolve-orbit-unparsed-units --dry-run
```

The duplicate command is always manual. The unparsed-unit command asks for
automatic or manual mode; manual mode shows every structurally valid candidate
without a Levenshtein-distance cutoff.

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
- unexpected matches: inspect and correct the link from `/rer-units` or
  `/rer-units/{id}`; automatic synchronization preserves manual links.

The deployment-oriented checklist is in the
[ORBIT import runbook](../deploy/2026-07-29-orbit-dictionaries/README.md).
