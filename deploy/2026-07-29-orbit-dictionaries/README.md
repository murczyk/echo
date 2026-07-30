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
`operational_unit_name_full` are retained. Matching compares normalized names by
echelon: platoon/company → company, battalion → battalion, regiment/brigade →
regiment, division → division, and corps/fieldArmy → army. Unsupported ORBIT
echelons are ignored. Matching requires at least one populated comparable level
on both sides; other absent comparable levels are compatible. Generative and
operational ancestors of matched roots are included.

Partial embedded ancestors are listed once for confirmation and then reviewed
parent-first. When a partial ancestor already exists, omitted source fields
preserve their stored values. Skipping a new ancestor, or declining to
reactivate a deleted ancestor, also skips dependent descendants. The review
offers:

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
