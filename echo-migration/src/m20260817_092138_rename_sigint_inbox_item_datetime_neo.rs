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
