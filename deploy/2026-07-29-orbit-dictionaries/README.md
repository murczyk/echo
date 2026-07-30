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

Only ORBIT roots that match an active Echo SIGINT unit by
`operationalUnitNameFull` are retained. Matching compares normalized names by
echelon: platoon/company → company, battalion → battalion, regiment/brigade →
regiment, division → division, and corps/fieldArmy → army. Unsupported ORBIT
echelons are ignored, and an absent comparable level on either side is
compatible. Generative and operational ancestors of matched roots are included.

Partial embedded ancestors are listed once for confirmation and then reviewed
parent-first. Rejecting an ancestor rejects dependent descendants. The review
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
