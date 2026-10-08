let's add a new table called sigint_unit_orbit_combat_type, it has 2 columns - orbit_combat_unit_type.id and name (text, not null). we should populate it with values from orbit_combat_unit_type upon creation - just copy names and ids from there, and upon upload/sync orbit data - import new orbit_combat_unit_type values (do not modify esixting ones).

also please add combat_type_id to sigint_unit (foreign key to sigint_unit_orbit_combat_type, nullable). add a new command to orbit TUI that populates this from linked orbit_unit for all sigint_unit entries that have a linked orbit_unit (do that carefully, each update in a separate  transaction to avoid huge slow transactions); this should be an idempotent operation, only update if data changed for a given sigint_unit. 

let's also rename column 'Група армій/Фронт/Види та роди ЗС' at /rer-units-neo to 'Група армій/Фронт'.

also add a new column called 'Види та роди ЗС' at /rer-units-neo (visible by default, goes after 'Регіон/ТВД/Збройні Сили'), show sigint_unit_orbit_combat_type.name of a relevant sigint_unit_orbit_combat_type entry (linked via sigint_unit.combat_type_id) here. make sure filtering and sorting works properly for this one. 


also make sure we can assign sigint_unit_orbit_combat_type to a sigint unit when editing it either at /rer-units-neo/ or /rer-units/{id}
