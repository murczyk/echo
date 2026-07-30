# ORBIT unit import

Run the one-off importer on the target Echo instance:

```sh
sudo wdintel-rs --mode=live tui-import-orbit-units
```

Enter the path to an ORBIT JSON export in the first TUI screen. The importer
validates known fields and hierarchy paths before writing anything. Unknown
properties are listed and require explicit confirmation.

The importer discovers dictionary values in both root units and embedded
parents. If a `(key, name)` value is absent from an `orbit_*` dictionary table,
it prints a timestamped reversible migration and the required
`echo-migration/src/lib.rs` registration snippets, then exits without importing
units. Add and apply that migration before rerunning the command.
Every value in a unit's `grouping_of_forces` array is retained through the
`orbit_unit_grouping_of_forces` many-to-many relation.

Only ORBIT roots that match an active Echo SIGINT unit by
`operational_unit_name_full` are retained. Matching uses normalized names from
the full path and known aliases even when an ORBIT descriptor has the wrong
echelon. Known echelon conflicts still reject a candidate. Extra full-name
segments without descriptors are allowed when the supplied descriptors remain
in hierarchy order. When several SIGINT units match, an exact root-echelon
match wins, followed by the candidate with the most matching names. An
unresolved tie with different parent paths is treated as fuzzy and skipped;
same-parent duplicates select the lowest ID. Generative and operational
ancestors of matched roots are included. After a completed review, active
imported roots are linked to the selected active Echo SIGINT unit. These links
drive the admin-only ORBIT indicator and unit-details card.
When a unit also appears inside another unit's path with a different parent,
the unit's own top-level parent chain is authoritative. Conflicting
embedded-only paths still fail when the ambiguous unit is selected.

Ancestors are imported parent-first without confirmation so the complete parent
tree exists before matched children are reviewed. New ancestors are created,
changed ancestors are updated, and deleted ancestors are reactivated
automatically. When a partial ancestor already exists, omitted source fields
preserve their stored values. Interactive create/update/reactivate prompts are
shown only for ORBIT roots selected by SIGINT matching. Rejecting a selected
parent also skips dependent descendants. The review offers:

- create or skip for new units;
- update or skip for changed units;
- reactivate or skip for deleted units;
- delete, skip, or skip all for stale active units.

Unchanged units and skipped changed/reactivation units are marked seen by
updating only `updated_at`. After review, active rows older than the import
start minus the five-second grace period are offered for soft deletion.
Confirmed changes are persisted immediately; quitting stops future work and
does not roll back earlier decisions.

## Preparing dictionary migrations

The version-controlled `dictionaries.json` is a developer aid, not a runtime
input. To collect new values while preparing a migration, run this from the
current directory:

```sh
just collect /path/to/orbit-export.json
```

Review the resulting dictionary diff and add the values through an
`echo-migration` migration. Runtime imports resolve dictionaries from
PostgreSQL.
