use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table sigint_unit
    add column present_in_orbit boolean;

create function sync_sigint_unit_present_in_orbit()
returns trigger
language plpgsql
as $$
declare
    unlinked_sigint_unit_id bigint;
begin
    if tg_op in ('INSERT', 'UPDATE')
       and new.is_suppressed = false
       and exists (
           select 1
           from orbit_unit
           where orbit_unit.unit_id = new.orbit_unit_id
             and orbit_unit.deleted = false
       ) then
        update sigint_unit
        set present_in_orbit = true
        where id = new.sigint_unit_id
          and present_in_orbit is distinct from true;
    end if;

    if tg_op = 'DELETE' and old.is_suppressed = false then
        unlinked_sigint_unit_id := old.sigint_unit_id;
    elsif tg_op = 'UPDATE'
          and old.is_suppressed = false
          and (
              new.is_suppressed = true
              or new.sigint_unit_id is distinct from old.sigint_unit_id
          ) then
        unlinked_sigint_unit_id := old.sigint_unit_id;
    end if;

    if unlinked_sigint_unit_id is not null then
        update sigint_unit
        set present_in_orbit = false
        where id = unlinked_sigint_unit_id
          and present_in_orbit is distinct from false
          and not exists (
              select 1
              from orbit_unit_sigint_unit link
              join orbit_unit
                on orbit_unit.unit_id = link.orbit_unit_id
              where link.sigint_unit_id = unlinked_sigint_unit_id
                and link.is_suppressed = false
                and orbit_unit.deleted = false
          );
    end if;

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

create trigger orbit_unit_sigint_unit_sync_present_in_orbit
after insert or update or delete on orbit_unit_sigint_unit
for each row execute function sync_sigint_unit_present_in_orbit();
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop trigger if exists orbit_unit_sigint_unit_sync_present_in_orbit
    on orbit_unit_sigint_unit;
drop function if exists sync_sigint_unit_present_in_orbit();
alter table sigint_unit drop column if exists present_in_orbit;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
