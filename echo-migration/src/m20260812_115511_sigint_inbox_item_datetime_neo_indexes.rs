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
create index sigint_inbox_item_datetime_backfill_idx
    on sigint_inbox_item (datetime, id)
    where datetime is not null and datetime_neo is null;

create index sigint_inbox_item_unit_v2_datetime_neo_idx
    on sigint_inbox_item (unit_v2, datetime_neo)
    include (id)
    where unit_v2 is not null and unit_v2 <> '';
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
drop index if exists sigint_inbox_item_unit_v2_datetime_neo_idx;
drop index if exists sigint_inbox_item_datetime_backfill_idx;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
