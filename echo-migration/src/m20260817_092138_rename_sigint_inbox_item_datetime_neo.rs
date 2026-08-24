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
lock table sigint_inbox_item in access exclusive mode;

do $$
begin
    if exists (
        select 1
        from sigint_inbox_item
        where datetime is distinct from datetime_neo
    ) then
        raise exception 'cannot switch sigint_inbox_item datetime columns before datetime_neo reconciliation completes';
    end if;
end
$$;

drop index sigint_inbox_item_datetime_backfill_idx;
drop index sigint_inbox_item_datetime_idx;
drop index sigint_inbox_item_unit_v2_datetime_idx;

alter index sigint_inbox_item_datetime_neo_idx
    rename to sigint_inbox_item_datetime_idx;
alter index sigint_inbox_item_unit_v2_datetime_neo_idx
    rename to sigint_inbox_item_unit_v2_datetime_idx;

alter table sigint_inbox_item
    rename column datetime to datetime_old;
alter table sigint_inbox_item
    rename column datetime_neo to datetime;
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
lock table sigint_inbox_item in access exclusive mode;

-- datetime_old is generated from date and time, so synchronize its inputs.
update sigint_inbox_item
set
    date = case
        when datetime is null then null
        else to_char(
            (datetime at time zone 'UTC') at time zone 'Europe/Kyiv',
            'YYYY-MM-DD'
        )
    end,
    time = case
        when datetime is null then null
        else to_char(
            (datetime at time zone 'UTC') at time zone 'Europe/Kyiv',
            'HH24:MI:SS.US'
        )
    end
where datetime is distinct from datetime_old;

do $$
begin
    if exists (
        select 1
        from sigint_inbox_item
        where datetime is distinct from datetime_old
    ) then
        raise exception 'cannot restore the legacy sigint_inbox_item datetime column without losing timestamps';
    end if;
end
$$;

alter table sigint_inbox_item
    rename column datetime to datetime_neo;
alter table sigint_inbox_item
    rename column datetime_old to datetime;

alter index sigint_inbox_item_datetime_idx
    rename to sigint_inbox_item_datetime_neo_idx;
alter index sigint_inbox_item_unit_v2_datetime_idx
    rename to sigint_inbox_item_unit_v2_datetime_neo_idx;

create index sigint_inbox_item_datetime_idx
    on sigint_inbox_item (datetime);

create index sigint_inbox_item_unit_v2_datetime_idx
    on sigint_inbox_item (unit_v2, datetime)
    include (id)
    where unit_v2 is not null and unit_v2 <> '';

create index sigint_inbox_item_datetime_backfill_idx
    on sigint_inbox_item (datetime, id)
    where datetime is not null and datetime_neo is null;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
