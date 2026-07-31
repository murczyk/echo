use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create table orbit_unit_grouping_of_forces (
    unit_id uuid not null references orbit_unit(unit_id) on delete cascade,
    grouping_of_forces_id uuid not null references orbit_grouping_of_forces(id),
    primary key (unit_id, grouping_of_forces_id)
);

create index orbit_unit_grouping_of_forces_grouping_idx
    on orbit_unit_grouping_of_forces (grouping_of_forces_id);

insert into orbit_unit_grouping_of_forces (unit_id, grouping_of_forces_id)
select unit_id, grouping_of_forces_id
from orbit_unit
where grouping_of_forces_id is not null;

alter table orbit_unit
    drop column grouping_of_forces_id;
"#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
do $$
begin
    if exists (
        select unit_id
        from orbit_unit_grouping_of_forces
        group by unit_id
        having count(*) > 1
    ) then
        raise exception 'cannot restore singular ORBIT grouping links while units have multiple groupings';
    end if;
end $$;

alter table orbit_unit
    add column grouping_of_forces_id uuid references orbit_grouping_of_forces(id);

update orbit_unit
set grouping_of_forces_id = links.grouping_of_forces_id
from orbit_unit_grouping_of_forces links
where links.unit_id = orbit_unit.unit_id;

drop table orbit_unit_grouping_of_forces;
"#,
            )
            .await?;
        Ok(())
    }
}
