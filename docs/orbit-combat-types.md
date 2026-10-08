# ORBIT combat types for SIGINT units

`sigint_unit_orbit_combat_type` stores the copied ORBIT dictionary's UUIDs and
names. The migration copies existing entries; subsequent ORBIT imports and
syncs insert missing IDs without changing existing names. The SIGINT dictionary
survives destructive ORBIT reimports. `sigint_unit.combat_type_id` is nullable
and references this retained dictionary.

The **Види та роди ЗС** column in `/rer-units-neo` is visible by default,
follows **Регіон/ТВД/Збройні Сили**, and supports text filtering and name sorting.
The shared editor on `/rer-units-neo` and `/rer-units/{id}` supports assignment,
replacement, and clearing through **Не визначено**. Omitting the field in an API
update preserves the current assignment; explicit `null` clears it. These SIGINT
attributes remain available when ORBIT source data is hidden.

## Explicit population from ORBIT links

Run the existing ORBIT TUI:

```bash
wdintel-rs --mode=live tui-import-orbit-units
```

Select **Populate linked SIGINT unit combat types**. The action considers
nondeleted SIGINT units and unsuppressed links to nondeleted ORBIT units,
including inactive SIGINT units. It collects distinct non-null combat-type IDs:

- One distinct ID replaces a different current assignment, including a manual assignment.
- Null types are ignored when one known type remains.
- Conflicting IDs or entirely null types leave the assignment unchanged and print the unit ID for manual review.
- Suppressed links, deleted ORBIT units, and unlinked SIGINT units do not supply a type.

Ordinary ORBIT sync does not populate or replace SIGINT assignments. The explicit
action reads bounded batches by SIGINT ID, rechecks source links while holding
the ORBIT import lock, and commits each changed unit in a separate transaction.
Unchanged values do not generate writes. Progress reports the last unit ID,
updated/unchanged/skipped counts, processing rate, and estimated remaining work
from the initial eligible-unit count. Interrupt or correct a failed row and rerun the
same action: committed rows are retained and skipped as unchanged, while a failed
unit's transaction is rolled back. Recheck skipped units manually.

## Deployment and recovery

Apply the application migrations through the normal deployment flow, including
its analytics reconciliation. The new dictionary joins replication automatically;
`sigint_unit` authorizes a targeted table resnapshot, following the existing
ORBIT-presence migration. No full mirror resync is requested.

Before moving to the next server, verify that the copied dictionary and
`combat_type_id` exist in PostgreSQL, raw ClickHouse tables, current-state views,
and the PostgreSQL gateway, and that the analytics health check is green. Use
[the targeted migration procedure](../deploy/clickhouse/README.md#the-correct-day-two-table-selection-solution)
for reconciliation and recovery. Stop deployment if reconciliation fails;
retry only the affected table through the documented helper:

```bash
just analytics-resnapshot-table --server <server> --table public.sigint_unit
```

After schema and analytics checks, run the TUI population action if existing
linked units should receive their ORBIT combat type. Review its skipped IDs;
this action can overwrite manual assignments when the source type is unambiguous.
Rolling the migration back removes SIGINT combat-type assignments and the copied
dictionary; first restore the application version that does not reference them.
